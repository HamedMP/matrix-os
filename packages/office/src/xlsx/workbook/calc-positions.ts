/**
 * Whether a row or column move changes what a formula gets from where its
 * references point rather than from the values there.
 *
 * A move rewrites references so that they follow their cells, and a formula
 * that reads only values reads the same values afterwards. A formula that
 * asks where a reference is (ROW, COLUMN, ROWS, COLUMNS), where it stands
 * itself (ROW(), COLUMN()) or picks cells by position (OFFSET, INDIRECT) can
 * get another answer. Those references are not in the cells it reads (see
 * `collectDeps`), so `calc-inputs.ts` asks here before a move.
 *
 * An OFFSET or INDIRECT argument that is not written out (`"A"&B1`,
 * `B1-5`) is worked out with the engine against the workbook as it is
 * before the move, and the address it gives is judged like a written one: its
 * cells follow the move, so it has the same value afterwards, and whatever
 * in it asks for a position is judged on its own by the same walk. What
 * cannot be worked out (an error value, an array, more cells than the move's
 * budget) is judged by the cells the last calculation read; a formula that
 * has not been calculated since it was opened keeps its date, as it does
 * when a cell it reads at run time is edited (`readsAny`).
 */

import type { CellProvider, FormulaAst, FormulaScalar, FormulaValue, RangeBounds } from "../../api/formula.js";
import { isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { type CalcNode, type Dep, MAX_NAME_DEPTH, collectDeps, functionsOf, pushChildren } from "./calc-graph.js";
import { makeProvider } from "./calc-provider.js";
import { errorValue } from "./calc-values.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { type StructuralOp, movePoint, moveSpan } from "./refs-rewrite.js";
import { sheetDimensions } from "./sheet-write.js";
import { parseCached } from "./state.js";

/** Cells that working out computed arguments may read during one move, across every formula it judges. */
export const MOVE_ARGUMENT_CELLS = 100_000;
/** Longest address text INDIRECT reads, as the engine has it. */
const MAX_REFERENCE_TEXT = 1024;

/** The functions that answer with where a reference is: the axis they ask about, and whether they ask its size. */
const POSITION_ASKS: ReadonlyMap<string, { axis: StructuralOp["axis"]; size: boolean }> = new Map([
  ["ROW", { axis: "row", size: false }],
  ["COLUMN", { axis: "col", size: false }],
  ["ROWS", { axis: "row", size: true }],
  ["COLUMNS", { axis: "col", size: true }],
]);

type Span = { low: number; high: number };

function spanOf(dep: Dep, op: StructuralOp): Span {
  return op.axis === "row" ? { low: dep.r1, high: dep.r2 } : { low: dep.c1, high: dep.c2 };
}

/** What working out computed arguments may still read during one move. */
interface ArgumentBudget {
  cells: number;
}

/** Cells a read of `bounds` covers, clipped to the used part of the sheet as the provider clips it. */
function usedArea(state: WorkbookState, bounds: RangeBounds): number {
  const sheet = state.sheetsByKey.get(bounds.sheet.toLowerCase());
  const used = sheet === undefined ? null : sheetDimensions(sheet);
  if (used === null) return 0;
  const lastRow = Math.min(bounds.endRow, used.end.row);
  const lastCol = Math.min(bounds.endCol, used.end.col);
  if (bounds.startRow > lastRow || bounds.startCol > lastCol) return 0;
  return (lastRow - bounds.startRow + 1) * (lastCol - bounds.startCol + 1);
}

/** The workbook's provider, refusing reads past the budget and noting in `meter` that it did. */
function meteredProvider(state: WorkbookState, budget: ArgumentBudget, meter: { over: boolean }): CellProvider {
  const inner = makeProvider(state, { reads: null, overflow: false });
  const spend = (count: number): boolean => {
    if (meter.over || count > budget.cells) {
      meter.over = true;
      return false;
    }
    budget.cells -= count;
    return true;
  };
  return {
    getCellValue: (sheet, row, col) => (spend(1) ? inner.getCellValue(sheet, row, col) : errorValue("#NUM!")),
    getRangeValues: (bounds) => (spend(usedArea(state, bounds)) ? inner.getRangeValues(bounds) : errorValue("#NUM!")),
    resolveName: (name, sheet) => inner.resolveName(name, sheet),
  };
}

/** A numeric argument as OFFSET takes it: null when empty or left out, undefined when unknown. */
function asInt(value: FormulaScalar | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function contains(outer: Dep, inner: Dep): boolean {
  return outer.sheet === inner.sheet && outer.r1 <= inner.r1 && outer.c1 <= inner.c1 && outer.r2 >= inner.r2 && outer.c2 >= inner.c2;
}

/** What a walk over one formula found out. */
interface Finding {
  changed: boolean;
  /** Cells picked at run time from an address the formula does not hold; only the last calculation knows them. */
  needsReads: boolean;
  /** The shifts that leave such a cell where the formula looks for it afterwards. */
  allowed: Set<number>;
}

class PositionWalk {
  readonly found: Finding = { changed: false, needsReads: false, allowed: new Set() };

  constructor(
    private readonly state: WorkbookState,
    private readonly node: CalcNode,
    private readonly sheet: SheetModel,
    private readonly op: StructuralOp,
    private readonly budget: ArgumentBudget,
  ) {}

  /**
   * The value of an argument before the move: written out, or worked out with
   * the engine. Undefined when it cannot be: an error value (a clock read
   * without a time among them), an array of several values, or more cells
   * than the budget leaves.
   */
  private argValue(ast: FormulaAst | undefined, context: SheetModel): FormulaScalar | undefined {
    if (ast === undefined || ast.type === "missing") return null;
    if (ast.type === "string" || ast.type === "number" || ast.type === "boolean") return ast.value;
    const state = this.state;
    const formula = state.formula;
    const functions = functionsOf(state);
    if (formula === null || functions === null) return undefined;
    const meter = { over: false };
    let value: FormulaValue;
    try {
      const date1904 = state.date1904;
      value = formula.evaluate(ast, {
        provider: meteredProvider(state, this.budget, meter),
        functions,
        sheet: context.name,
        row: this.node.row,
        col: this.node.col,
        now: null,
        date1904,
        formatValue: (scalar, code) => formatValue(scalar, code, { date1904 }),
      });
    } catch (error) {
      // As in a run: a typed failure is an answer the formula has no value for; anything else is a defect.
      if (!isOfficeError(error)) throw error;
      return undefined;
    }
    if (meter.over) return undefined;
    if (value !== null && typeof value === "object" && value.kind === "array") {
      if (value.rows > 1 || value.cols > 1) return undefined;
      value = value.values[0]?.[0] ?? null;
    }
    return value !== null && typeof value === "object" ? undefined : value;
  }

  /** A whole-number argument of OFFSET: null when empty or left out, undefined when unknown. */
  private intArg(ast: FormulaAst | undefined, context: SheetModel): number | null | undefined {
    return asInt(this.argValue(ast, context));
  }

  /** Cells the formula reads from an address it does not hold: judged by the last calculation. */
  private unknown(shift: number): void {
    this.found.needsReads = true;
    this.found.allowed.add(shift);
  }

  /** The references in `ast` on the moved sheet, with their spans along the moved axis. */
  private refsOn(ast: FormulaAst, context: SheetModel, depth: number): Dep[] {
    const deps: Dep[] = [];
    collectDeps(this.state, ast, context, depth, deps);
    return deps.filter((dep) => dep.sheet === this.sheet);
  }

  walk(ast: FormulaAst, context: SheetModel, depth: number): void {
    const stack: FormulaAst[] = [ast];
    const children: FormulaAst[] = [];
    while (stack.length > 0 && !this.found.changed) {
      const node = stack.pop() as FormulaAst;
      if (node.type === "name") {
        if (depth >= MAX_NAME_DEPTH) continue;
        const scope = node.sheet === null ? context : (this.state.sheetsByKey.get(node.sheet.toLowerCase()) ?? null);
        const name = lookupName(this.state, node.name, scope);
        const inner = name === null ? null : parseCached(this.state, name.refersTo);
        if (name !== null && inner !== null) this.walk(inner, name.scope ?? context, depth + 1);
        continue;
      }
      if (node.type === "call") this.call(node.name, node.args, context, depth);
      children.length = 0;
      pushChildren(node, children);
      for (const child of children) stack.push(child);
    }
  }

  private call(name: string, args: readonly FormulaAst[], context: SheetModel, depth: number): void {
    const op = this.op;
    const ask = POSITION_ASKS.get(name);
    if (ask !== undefined) {
      const arg = args[0];
      if (arg === undefined || arg.type === "missing") {
        // ROW() and COLUMN() answer with the formula's own place.
        const own = op.axis === "row" ? this.node.row : this.node.col;
        if (!ask.size && ask.axis === op.axis && this.node.sheet === this.sheet && movePoint(own, op) !== own) this.found.changed = true;
        return;
      }
      for (const dep of this.refsOn(arg, context, depth)) {
        const span = spanOf(dep, op);
        const moved = moveSpan(span.low, span.high, op);
        // A reference with nothing left of it becomes #REF!.
        if (moved === null) this.found.changed = true;
        else if (ask.axis !== op.axis) continue;
        else if (ask.size ? moved.high - moved.low !== span.high - span.low : moved.low !== span.low || moved.high !== span.high) {
          this.found.changed = true;
        }
      }
      return;
    }
    if (name === "OFFSET") this.offset(args, context, depth);
    else if (name === "INDIRECT") this.indirect(args, context);
  }

  /** OFFSET reads other cells when its base moves and the cells it lands on do not move alike. */
  private offset(args: readonly FormulaAst[], context: SheetModel, depth: number): void {
    const base = args[0];
    if (base === undefined) return;
    const op = this.op;
    const deps = this.refsOn(base, context, depth);
    if (deps.length === 0) return;
    const by = this.intArg(op.axis === "row" ? args[1] : args[2], context);
    const givenSize = this.intArg(op.axis === "row" ? args[3] : args[4], context);
    for (const dep of deps) {
      const span = spanOf(dep, op);
      const moved = moveSpan(span.low, span.high, op);
      if (moved === null) {
        this.found.changed = true;
        return;
      }
      if (by === undefined || givenSize === undefined) {
        // Where it lands is known only from the last calculation.
        this.unknown(moved.low - span.low);
        continue;
      }
      const shift = by ?? 0;
      const size = givenSize ?? span.high - span.low + 1;
      // A height or width below one is #REF! wherever the base is.
      if (size < 1) continue;
      const low = span.low + shift;
      const next = moved.low + shift;
      // Above the first row or left of the first column it is #REF!; the moved base may now land on the sheet.
      if (low < 0) {
        if (next >= 0) this.found.changed = true;
        continue;
      }
      // The cells it landed on must be the ones it lands on now.
      const target = moveSpan(low, low + size - 1, op);
      if (target === null || target.low !== next || target.high !== next + size - 1) this.found.changed = true;
    }
  }

  /** INDIRECT reads the cells at an address the move does not rewrite: it reads other cells when they move. */
  private indirect(args: readonly FormulaAst[], context: SheetModel): void {
    const text = this.argValue(args[0], context);
    const a1 = this.argValue(args[1], context);
    if (text === undefined || a1 === undefined) {
      this.unknown(0);
      return;
    }
    // R1C1 text, or anything but text, is #REF! before and after.
    const isA1 = a1 === null || a1 === true || (typeof a1 === "number" && a1 !== 0) || (typeof a1 === "string" && a1.trim().toUpperCase() === "TRUE");
    if (!isA1 || typeof text !== "string") return;
    const trimmed = text.trim();
    if (trimmed.length > MAX_REFERENCE_TEXT) return;
    const ast = trimmed === "" ? null : parseCached(this.state, trimmed.startsWith("=") ? trimmed.slice(1) : trimmed);
    // A name follows its cells like any reference; anything but an address is #REF! before and after.
    if (ast === null || (ast.type !== "cell" && ast.type !== "range")) return;
    for (const dep of this.refsOn(ast, context, MAX_NAME_DEPTH)) {
      const span = spanOf(dep, this.op);
      const moved = moveSpan(span.low, span.high, this.op);
      if (moved === null || moved.low !== span.low || moved.high !== span.high) this.found.changed = true;
    }
  }
}

/**
 * Judges, for one row or column move on `sheet`, whether it changes the
 * answer a formula gets from where a reference points: ROW, COLUMN, ROWS or
 * COLUMNS of a reference the move shifts or resizes along that axis, ROW() or
 * COLUMN() of a formula the move shifts, OFFSET from a base whose target does
 * not move alike, INDIRECT of an address whose cells moved away. Computed
 * OFFSET and INDIRECT arguments are worked out first, within
 * {@link MOVE_ARGUMENT_CELLS} cells for the whole move. Cells picked at run
 * time from an address that still cannot be worked out are judged by the
 * cells the last calculation read: any of them that does not follow the move
 * alike, or more than were kept, counts as changed. Without a last
 * calculation the formula keeps its date (see the file comment).
 */
export function positionsAcrossMove(state: WorkbookState, sheet: SheetModel, op: StructuralOp): (node: CalcNode) => boolean {
  const budget: ArgumentBudget = { cells: MOVE_ARGUMENT_CELLS };
  return (node) => {
    const walk = new PositionWalk(state, node, sheet, op, budget);
    walk.walk(node.ast, node.sheet, 0);
    const found = walk.found;
    if (found.changed) return true;
    if (!found.needsReads) return false;
    if (node.readsAll) return true;
    if (node.reads === null) return false;
    for (const read of node.reads) {
      // A cell the formula names follows the move like the reference does.
      if (read.sheet !== sheet || node.deps.some((dep) => contains(dep, read))) continue;
      const span = spanOf(read, op);
      const moved = moveSpan(span.low, span.high, op);
      if (moved === null || moved.high - moved.low !== span.high - span.low || !found.allowed.has(moved.low - span.low)) return true;
    }
    return false;
  };
}
