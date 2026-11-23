/**
 * The dependency graph of a workbook: one node per formula cell the engine
 * can calculate, and the order in which to calculate them.
 *
 * Nothing here recurses: the order is found with an explicit stack, so a
 * chain of ten thousand cells cannot overflow the call stack.
 */

import type { FormulaAst, FunctionRegistry } from "../../api/formula.js";
import type { CellRec, SheetModel, WorkbookState } from "./model.js";
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
  ast: FormulaAst;
  deps: Dep[];
  /** Calculated on every run: a volatile function, or one that picks its cells at run time. */
  always: boolean;
  /** Visit number of the ordering pass; -1 before the visit. */
  index: number;
  /** Lowest visit number reachable from this node (strongly connected components). */
  low: number;
  onStack: boolean;
  /** True when the formula is part of a circular reference. */
  circular: boolean;
}

export interface CalcGraph {
  nodes: CalcNode[];
  /** Formula nodes of each sheet by column, sorted by row. Bounded by the formula cell count. */
  columns: Map<SheetModel, Map<number, CalcNode[]>>;
  /** Nodes with their precedents first; null until computed. */
  order: CalcNode[] | null;
}

/** Functions whose result depends on cells their arguments do not name. */
const DYNAMIC_FUNCTIONS: ReadonlySet<string> = new Set(["OFFSET", "INDIRECT"]);
/** How many defined names may be followed inside one another. */
const MAX_NAME_DEPTH = 8;

/** True when some function call of the formula satisfies `test`. */
function someCall(ast: FormulaAst, test: (name: string) => boolean): boolean {
  const stack: FormulaAst[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop() as FormulaAst;
    switch (node.type) {
      case "call":
        if (test(node.name)) return true;
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
      default:
        break;
    }
  }
  return false;
}

/** True when the formula calls a volatile or a dynamic-reference function. */
function callsAlways(ast: FormulaAst, functions: FunctionRegistry): boolean {
  return someCall(ast, (name) => DYNAMIC_FUNCTIONS.has(name) || functions.get(name)?.volatile === true);
}

/** Whether a parsed formula calls a function the registry lacks. Entries go away with their trees. */
const unknownCalls = new WeakMap<FormulaAst, boolean>();

/** The function registry of the workbook, created on first use. Null without a formula engine. */
export function functionsOf(state: WorkbookState): FunctionRegistry | null {
  if (state.functions === null && state.formula !== null) state.functions = state.formula.createFunctionRegistry();
  return state.functions;
}

/**
 * True when the formula calls a function the engine does not have. Such a
 * formula would calculate to `#NAME?`; the workbook keeps the value stored
 * with it instead.
 */
export function callsUnknownFunction(state: WorkbookState, ast: FormulaAst): boolean {
  let unknown = unknownCalls.get(ast);
  if (unknown === undefined) {
    const functions = functionsOf(state);
    unknown = functions !== null && someCall(ast, (name) => !functions.has(name));
    unknownCalls.set(ast, unknown);
  }
  return unknown;
}

/** The rectangles a formula reads, following defined names. */
export function collectDeps(state: WorkbookState, ast: FormulaAst, sheet: SheetModel, depth: number, out: Dep[]): void {
  const formula = state.formula;
  if (formula === null) return;
  for (const ref of formula.collectReferences(ast)) {
    const target = ref.sheet === null ? sheet : state.sheetsByKey.get(ref.sheet.toLowerCase());
    if (ref.type === "name") {
      if (depth >= MAX_NAME_DEPTH) continue;
      const name = lookupName(state, ref.name, target ?? null);
      const inner = name === null ? null : parseCached(state, name.refersTo);
      if (name !== null && inner !== null) collectDeps(state, inner, name.scope ?? sheet, depth + 1, out);
    } else if (target === undefined) {
      continue;
    } else if (ref.type === "cell") {
      out.push({ sheet: target, r1: ref.row, c1: ref.col, r2: ref.row, c2: ref.col });
    } else {
      out.push({
        sheet: target,
        r1: Math.min(ref.start.row, ref.end.row),
        c1: Math.min(ref.start.col, ref.end.col),
        r2: Math.max(ref.start.row, ref.end.row),
        c2: Math.max(ref.start.col, ref.end.col),
      });
    }
  }
}

export function buildGraph(state: WorkbookState): CalcGraph {
  const nodes: CalcNode[] = [];
  const functions = functionsOf(state);
  if (functions === null) return { nodes, columns: new Map(), order: null };
  const columns = new Map<SheetModel, Map<number, CalcNode[]>>();
  for (const sheet of state.sheets) {
    const byColumn = new Map<number, CalcNode[]>();
    for (const row of sheet.rows.values()) {
      for (const [col, cell] of row.cells) {
        if (cell.formula === null || cell.extra !== null) continue;
        const ast = parseCached(state, cell.formula);
        if (ast === null) continue;
        // A formula with a function the engine lacks keeps its stored value; a new one shows #NAME? once.
        if (cell.value !== null && callsUnknownFunction(state, ast)) continue;
        const deps: Dep[] = [];
        collectDeps(state, ast, sheet, 0, deps);
        const node: CalcNode = {
          sheet,
          row: row.index,
          col,
          cell,
          ast,
          deps,
          always: callsAlways(ast, functions),
          index: -1,
          low: -1,
          onStack: false,
          circular: false,
        };
        nodes.push(node);
        const list = byColumn.get(col);
        if (list === undefined) byColumn.set(col, [node]);
        else list.push(node);
      }
    }
    for (const list of byColumn.values()) list.sort((a, b) => a.row - b.row);
    if (byColumn.size > 0) columns.set(sheet, byColumn);
  }
  return { nodes, columns, order: null };
}

function lowerBound(list: readonly CalcNode[], row: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((list[mid] as CalcNode).row < row) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Walks the formula cells a node reads, one at a time, without building a list of them. */
class Precedents {
  private depIndex = 0;
  private lists: CalcNode[][] = [];
  private listIndex = 0;
  private list: CalcNode[] | null = null;
  private position = 0;
  private lastRow = 0;

  constructor(
    private readonly graph: CalcGraph,
    private readonly deps: readonly Dep[],
  ) {}

  next(): CalcNode | null {
    for (;;) {
      const list = this.list;
      if (list !== null) {
        const candidate = list[this.position];
        if (candidate !== undefined && candidate.row <= this.lastRow) {
          this.position++;
          return candidate;
        }
        this.list = null;
      }
      if (this.listIndex < this.lists.length) {
        const nextList = this.lists[this.listIndex++] as CalcNode[];
        this.list = nextList;
        this.position = lowerBound(nextList, (this.deps[this.depIndex - 1] as Dep).r1);
        continue;
      }
      const dep = this.deps[this.depIndex++];
      if (dep === undefined) return null;
      this.lists = [];
      this.listIndex = 0;
      this.lastRow = dep.r2;
      const columns = this.graph.columns.get(dep.sheet);
      if (columns === undefined) continue;
      if (dep.c2 - dep.c1 + 1 <= columns.size) {
        for (let col = dep.c1; col <= dep.c2; col++) {
          const found = columns.get(col);
          if (found !== undefined) this.lists.push(found);
        }
      } else {
        for (const [col, found] of columns) if (col >= dep.c1 && col <= dep.c2) this.lists.push(found);
      }
    }
  }
}

/**
 * Orders the nodes so that each comes after the formula cells it reads, and
 * flags every node of a circular reference (a strongly connected component
 * of more than one node, or a formula that reads its own cell). Returns
 * false when a chain is deeper than `maxDepth`; the order then holds only
 * the nodes finished before that.
 */
export function orderGraph(graph: CalcGraph, maxDepth: number): { order: CalcNode[]; complete: boolean } {
  for (const node of graph.nodes) {
    node.index = -1;
    node.onStack = false;
    node.circular = false;
  }
  const order: CalcNode[] = [];
  const stack: CalcNode[] = [];
  const walkers: Precedents[] = [];
  const component: CalcNode[] = [];
  let counter = 0;
  const enter = (node: CalcNode): void => {
    node.index = counter;
    node.low = counter++;
    node.onStack = true;
    component.push(node);
    stack.push(node);
    walkers.push(new Precedents(graph, node.deps));
  };
  for (const root of graph.nodes) {
    if (root.index !== -1) continue;
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as CalcNode;
      const next = (walkers[walkers.length - 1] as Precedents).next();
      if (next === null) {
        if (top.low === top.index) {
          // `top` closes a component: everything above it on the component stack belongs to it.
          const first = component.lastIndexOf(top);
          if (component.length - first > 1) for (let i = first; i < component.length; i++) (component[i] as CalcNode).circular = true;
          for (let i = first; i < component.length; i++) (component[i] as CalcNode).onStack = false;
          component.length = first;
        }
        order.push(top);
        stack.pop();
        walkers.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined && top.low < parent.low) parent.low = top.low;
      } else if (next.index === -1) {
        if (stack.length >= maxDepth) return { order, complete: false };
        enter(next);
      } else if (next.onStack) {
        if (next === top) top.circular = true;
        if (next.index < top.low) top.low = next.index;
      }
    }
  }
  return { order, complete: true };
}
