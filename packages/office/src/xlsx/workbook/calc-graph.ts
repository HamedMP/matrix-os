/**
 * The dependency graph of a workbook: one node per formula cell the engine
 * can calculate, with the cells each formula reads. `calc-order.ts` finds
 * the order in which to calculate them.
 */

import type { FormulaAst, FunctionRegistry } from "../../api/formula.js";
import type { CellRange } from "../../api/xlsx.js";
import type { CellRec, NameRec, SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { parseCached } from "./state.js";

/** A rectangle a formula reads, inclusive. */
export interface Dep {
  sheet: SheetModel;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface CalcNode {
  sheet: SheetModel;
  row: number;
  col: number;
  cell: CellRec;
  /** The formula text the node was built from. */
  formula: string;
  ast: FormulaAst;
  deps: Dep[];
  /**
   * For an array formula: the range it fills, with this cell at the top
   * left. Null for an ordinary formula.
   */
  spill: CellRange | null;
  /** Calls a volatile function (NOW, RAND): calculated on every run the caller asks for. */
  volatile: boolean;
  /** Calls a function that picks its cells at run time (OFFSET, INDIRECT). */
  dynamic: boolean;
  /** Calls a function that needs the time of the run (NOW, TODAY). */
  clock: boolean;
  /**
   * For a dynamic node: the rectangles its last calculation read, or null
   * before the first one. At most `MAX_READS`; beyond that {@link readsAll} is set.
   */
  reads: Dep[] | null;
  /** The last calculation read more rectangles than are kept: any change may concern it. */
  readsAll: boolean;
  /** How many values the run had stored when this node was last calculated in it, before and after its own. */
  evalAt: number;
  doneAt: number;
  /** How often the run calculated this node again because a cell it read was stored after it. */
  turns: number;
  /** Visit number of the ordering pass; -1 before the visit. */
  index: number;
  /** Lowest visit number reachable from this node (strongly connected components). */
  low: number;
  onStack: boolean;
  /** True when the formula is part of a circular reference. */
  circular: boolean;
  /** Left out of the order of this run: it reads, directly or not, a chain deeper than the bound. */
  blocked: boolean;
}

export interface CalcGraph {
  nodes: CalcNode[];
  /** Formula nodes of each sheet by column, sorted by row. Bounded by the formula cell count. */
  columns: Map<SheetModel, Map<number, CalcNode[]>>;
  /** Array formulas that fill more than their own cell: reading any cell of their range reads them. */
  spills: CalcNode[];
  /** The nodes that pick their cells at run time. */
  dynamic: CalcNode[];
  /** The nodes that need the time of the run. */
  clock: CalcNode[];
  /** Nodes with their precedents first; null until computed. */
  order: CalcNode[] | null;
}

/** Functions whose result depends on cells their arguments do not name. */
const DYNAMIC_FUNCTIONS: ReadonlySet<string> = new Set(["OFFSET", "INDIRECT"]);
/** Functions that need the time of the run. */
export const CLOCK_FUNCTIONS: ReadonlySet<string> = new Set(["NOW", "TODAY"]);
/**
 * Functions that use where a reference points and never the values there.
 * A reference given to one of them directly is not read: `ROW(A1)` in A1 is
 * no circular reference.
 */
const POSITION_FUNCTIONS: ReadonlySet<string> = new Set(["ROW", "COLUMN", "ROWS", "COLUMNS", "AREAS", "SHEET", "SHEETS", "ISREF"]);
/**
 * Functions that stretch or shrink their third argument (the sum range) to
 * the size of their first (the criteria range), so they read cells the third
 * argument does not name. See `resizedGrid` of the formula functions.
 */
const RESIZING_FUNCTIONS: ReadonlySet<string> = new Set(["SUMIF", "AVERAGEIF"]);
const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;
/**
 * How many defined names are followed inside one another when the graph is
 * built. A formula that reaches deeper is treated like one that picks its
 * cells at run time: the cells its calculation reads are recorded then.
 */
export const MAX_NAME_DEPTH = 8;
/** Largest range one array formula fills; a larger one keeps its stored values. */
export const MAX_ARRAY_FORMULA_CELLS = 100_000;

/**
 * The range an array formula at `row`, `col` fills, or null when the cell
 * holds no array formula the engine calculates: an ordinary formula, a data
 * table, a formula that is not at the top left of its range, or a range
 * larger than {@link MAX_ARRAY_FORMULA_CELLS}.
 */
export function arrayFormulaRange(cell: CellRec, row: number, col: number): CellRange | null {
  const extra = cell.extra;
  if (extra === null || extra.ref === null) return null;
  if (!extra.attrs.some(([name, value]) => name === "t" && value === "array")) return null;
  const { start, end } = extra.ref;
  if (start.row !== row || start.col !== col) return null;
  if ((end.row - start.row + 1) * (end.col - start.col + 1) > MAX_ARRAY_FORMULA_CELLS) return null;
  return extra.ref;
}

/** The nodes inside `node`, for a walk with an explicit stack. */
export function pushChildren(node: FormulaAst, stack: FormulaAst[]): void {
  switch (node.type) {
    case "call":
      for (const arg of node.args) stack.push(arg);
      break;
    case "unary":
      stack.push(node.operand);
      break;
    case "binary":
      stack.push(node.left, node.right);
      break;
    case "paren":
      stack.push(node.inner);
      break;
    case "array":
      for (const row of node.rows) for (const item of row) stack.push(item);
      break;
    default: {
      // The reference operators of the full grammar (`A1:INDEX(B:B,3)`, a union) have two sides.
      const sides = node as { left?: FormulaAst; right?: FormulaAst };
      if (sides.left !== undefined && sides.right !== undefined) stack.push(sides.left, sides.right);
      break;
    }
  }
}

/** The rectangle of a cell or range written in the formula (in parentheses or not), or null for anything else. */
function writtenRect(state: WorkbookState, node: FormulaAst, sheet: SheetModel): Dep | null {
  let inner = node;
  while (inner.type === "paren") inner = inner.inner;
  if (inner.type !== "cell" && inner.type !== "range") return null;
  const target = inner.sheet === null ? sheet : state.sheetsByKey.get(inner.sheet.toLowerCase());
  if (target === undefined) return null;
  if (inner.type === "cell") return { sheet: target, r1: inner.row, c1: inner.col, r2: inner.row, c2: inner.col };
  return {
    sheet: target,
    r1: Math.min(inner.start.row, inner.end.row),
    c1: Math.min(inner.start.col, inner.end.col),
    r2: Math.max(inner.start.row, inner.end.row),
    c2: Math.max(inner.start.col, inner.end.col),
  };
}

/**
 * For a SUMIF or AVERAGEIF call with a sum range: the rectangle the sum range
 * is read over, sized as the criteria range; `"unknown"` when the size or the
 * start is known only at run time (a name, a function); null for any other call.
 */
function resizedRead(state: WorkbookState, node: FormulaAst, sheet: SheetModel): Dep | "unknown" | null {
  if (node.type !== "call" || !RESIZING_FUNCTIONS.has(node.name) || node.args.length < 3) return null;
  const [criteria, , sum] = node.args as [FormulaAst, FormulaAst, FormulaAst];
  const range = writtenRect(state, criteria, sheet);
  const start = writtenRect(state, sum, sheet);
  if (range === null || start === null) return "unknown";
  return {
    sheet: start.sheet,
    r1: start.r1,
    c1: start.c1,
    r2: Math.min(LAST_ROW, start.r1 + range.r2 - range.r1),
    c2: Math.min(LAST_COL, start.c1 + range.c2 - range.c1),
  };
}

/**
 * True for a call that picks its cells at run time: OFFSET, INDIRECT, or a
 * SUMIF or AVERAGEIF whose sum range is sized only then. The cells it reads
 * are not in {@link collectDeps}.
 */
export function picksCells(state: WorkbookState, node: FormulaAst, sheet: SheetModel): boolean {
  return node.type === "call" && (DYNAMIC_FUNCTIONS.has(node.name) || resizedRead(state, node, sheet) === "unknown");
}

/** What the functions of a formula, and of the names it uses, ask of the calculation. */
interface Traits {
  volatile: boolean;
  dynamic: boolean;
  clock: boolean;
}

function addTraits(state: WorkbookState, ast: FormulaAst, sheet: SheetModel, functions: FunctionRegistry, depth: number, traits: Traits): void {
  const stack: FormulaAst[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop() as FormulaAst;
    if (node.type === "call") {
      if (picksCells(state, node, sheet)) traits.dynamic = true;
      else if (functions.get(node.name)?.volatile === true) traits.volatile = true;
      if (CLOCK_FUNCTIONS.has(node.name)) traits.clock = true;
    } else if (node.type === "name" && depth >= MAX_NAME_DEPTH) {
      // `collectDeps` stops here too, so the cells of the rest of the chain are recorded while it runs.
      traits.dynamic = true;
    } else if (node.type === "name") {
      const scope = node.sheet === null ? sheet : (state.sheetsByKey.get(node.sheet.toLowerCase()) ?? null);
      const name = lookupName(state, node.name, scope);
      const inner = name === null ? null : parseCached(state, name.refersTo);
      if (name !== null && inner !== null) addTraits(state, inner, name.scope ?? sheet, functions, depth + 1, traits);
    }
    pushChildren(node, stack);
  }
}

/** What a parsed formula calls and names, for {@link callsUnknownFunction}. */
interface CallSummary {
  /** True when the formula itself calls a function the registry lacks. */
  unknown: boolean;
  /** The defined names the formula uses. */
  names: Array<Extract<FormulaAst, { type: "name" }>>;
}

/** Call summaries of parsed formulas. Entries go away with their trees. */
const callSummaries = new WeakMap<FormulaAst, CallSummary>();

/** The function registry of the workbook, created on first use. Null without a formula engine. */
export function functionsOf(state: WorkbookState): FunctionRegistry | null {
  if (state.functions === null && state.formula !== null) state.functions = state.formula.createFunctionRegistry();
  return state.functions;
}

function callSummary(ast: FormulaAst, functions: FunctionRegistry): CallSummary {
  let summary = callSummaries.get(ast);
  if (summary === undefined) {
    const names: CallSummary["names"] = [];
    let unknown = false;
    const stack: FormulaAst[] = [ast];
    while (stack.length > 0) {
      const node = stack.pop() as FormulaAst;
      if (node.type === "call" && !functions.has(node.name)) unknown = true;
      else if (node.type === "name") names.push(node);
      pushChildren(node, stack);
    }
    summary = { unknown, names };
    callSummaries.set(ast, summary);
  }
  return summary;
}

/**
 * True when the formula, or a defined name it uses (followed to any depth),
 * calls a function the engine does not have. Such a formula would calculate
 * to `#NAME?`; the workbook keeps the value stored with it instead. Names
 * are looked up on every call, so redefining one takes effect at once.
 */
export function callsUnknownFunction(state: WorkbookState, ast: FormulaAst, sheet: SheetModel | null): boolean {
  const functions = functionsOf(state);
  if (functions === null) return false;
  // Each name is followed once, so the walk ends; the set holds at most every name of the workbook.
  const seen = new Set<NameRec>();
  const pending: Array<{ ast: FormulaAst; sheet: SheetModel | null }> = [{ ast, sheet }];
  while (pending.length > 0) {
    const next = pending.pop() as { ast: FormulaAst; sheet: SheetModel | null };
    const summary = callSummary(next.ast, functions);
    if (summary.unknown) return true;
    for (const node of summary.names) {
      const scope = node.sheet === null ? next.sheet : (state.sheetsByKey.get(node.sheet.toLowerCase()) ?? null);
      const name = lookupName(state, node.name, scope);
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      const inner = parseCached(state, name.refersTo);
      if (inner !== null) pending.push({ ast: inner, sheet: name.scope ?? next.sheet });
    }
  }
  return false;
}

/** True for a reference, in parentheses or not, whose cells a position function does not read. */
function isPlainReference(state: WorkbookState, node: FormulaAst, sheet: SheetModel, depth: number): boolean {
  let inner = node;
  while (inner.type === "paren") inner = inner.inner;
  if (inner.type === "cell" || inner.type === "range") return true;
  if (inner.type !== "name" || depth >= MAX_NAME_DEPTH) return false;
  // A name for a plain range is as good as the range; a name for a formula may read cells.
  const scope = inner.sheet === null ? sheet : (state.sheetsByKey.get(inner.sheet.toLowerCase()) ?? null);
  const name = lookupName(state, inner.name, scope);
  const ast = name === null ? null : parseCached(state, name.refersTo);
  return name !== null && ast !== null && isPlainReference(state, ast, name.scope ?? sheet, depth + 1);
}

/**
 * The rectangles whose values a formula reads, following defined names. A
 * reference handed straight to a function that only asks where it points
 * (`ROW(A1)`, `COLUMNS($C$1:C1)`) is left out.
 */
export function collectDeps(state: WorkbookState, ast: FormulaAst, sheet: SheetModel, depth: number, out: Dep[]): void {
  if (state.formula === null) return;
  // Reversed pushes keep the rectangles in the order the formula names them.
  const stack: FormulaAst[] = [ast];
  const children: FormulaAst[] = [];
  while (stack.length > 0) {
    const node = stack.pop() as FormulaAst;
    if (node.type === "cell" || node.type === "range" || node.type === "name") {
      const target = node.sheet === null ? sheet : state.sheetsByKey.get(node.sheet.toLowerCase());
      if (node.type === "name") {
        if (depth >= MAX_NAME_DEPTH) continue;
        const name = lookupName(state, node.name, target ?? null);
        const inner = name === null ? null : parseCached(state, name.refersTo);
        if (name !== null && inner !== null) collectDeps(state, inner, name.scope ?? sheet, depth + 1, out);
      } else if (target === undefined) {
        continue;
      } else if (node.type === "cell") {
        out.push({ sheet: target, r1: node.row, c1: node.col, r2: node.row, c2: node.col });
      } else {
        out.push({
          sheet: target,
          r1: Math.min(node.start.row, node.end.row),
          c1: Math.min(node.start.col, node.end.col),
          r2: Math.max(node.start.row, node.end.row),
          c2: Math.max(node.start.col, node.end.col),
        });
      }
      continue;
    }
    children.length = 0;
    const resized = resizedRead(state, node, sheet);
    if (resized !== null && resized !== "unknown") out.push(resized);
    if (node.type === "call" && POSITION_FUNCTIONS.has(node.name)) {
      for (const arg of node.args) if (!isPlainReference(state, arg, sheet, depth)) children.push(arg);
    } else {
      pushChildren(node, children);
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as FormulaAst);
  }
}

export function buildGraph(state: WorkbookState): CalcGraph {
  const nodes: CalcNode[] = [];
  const functions = functionsOf(state);
  if (functions === null) return { nodes, columns: new Map(), spills: [], dynamic: [], clock: [], order: null };
  const columns = new Map<SheetModel, Map<number, CalcNode[]>>();
  const spills: CalcNode[] = [];
  const dynamic: CalcNode[] = [];
  const clock: CalcNode[] = [];
  for (const sheet of state.sheets) {
    const byColumn = new Map<number, CalcNode[]>();
    for (const row of sheet.rows.values()) {
      for (const [col, cell] of row.cells) {
        if (cell.formula === null) continue;
        const spill = arrayFormulaRange(cell, row.index, col);
        // A data table, or an array formula the engine does not fill, keeps its stored values.
        if (cell.extra !== null && spill === null) continue;
        const ast = parseCached(state, cell.formula);
        if (ast === null) continue;
        // A formula with a function the engine lacks keeps its stored value; a new one shows #NAME? once.
        if (cell.value !== null && callsUnknownFunction(state, ast, sheet)) continue;
        const deps: Dep[] = [];
        collectDeps(state, ast, sheet, 0, deps);
        const traits: Traits = { volatile: false, dynamic: false, clock: false };
        addTraits(state, ast, sheet, functions, 0, traits);
        const node: CalcNode = {
          sheet,
          row: row.index,
          col,
          cell,
          formula: cell.formula,
          ast,
          deps,
          spill,
          ...traits,
          reads: null,
          readsAll: false,
          evalAt: 0,
          doneAt: 0,
          turns: 0,
          index: -1,
          low: -1,
          onStack: false,
          circular: false,
          blocked: false,
        };
        nodes.push(node);
        if (node.dynamic) dynamic.push(node);
        if (node.clock) clock.push(node);
        if (spill !== null && (spill.end.row > spill.start.row || spill.end.col > spill.start.col)) spills.push(node);
        const list = byColumn.get(col);
        if (list === undefined) byColumn.set(col, [node]);
        else list.push(node);
      }
    }
    for (const list of byColumn.values()) list.sort((a, b) => a.row - b.row);
    if (byColumn.size > 0) columns.set(sheet, byColumn);
  }
  return { nodes, columns, spills, dynamic, clock, order: null };
}
