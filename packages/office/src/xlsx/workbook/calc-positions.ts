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
 * before the move, and converted with the engine's own argument helpers, as
 * the function converts it (`"-400%"` is -4). The address it gives is judged
 * like a written one: its cells follow the move, so it has the same value
 * afterwards, and whatever in it asks for a position is judged on its own by
 * the same walk. A value the function cannot take (text that is no number)
 * makes it an error before and after, which the move does not change.
 *
 * Each formula is so either proved unaffected, proved affected, or left
 * unresolved: an argument that evaluates to an error (a clock read without a
 * time among them), to several values INDIRECT would take one by one, or
 * that needs more cells than the move's budget. An unresolved formula is
 * judged by the cells the last calculation read. A formula that has not been
 * calculated since it was opened has no such record, and it is calculated
 * again: keeping its date could keep a value the moved formula no longer
 * gives, while calculating it without a time costs at most the date it would
 * have kept.
 */

import type { CellProvider, FormulaAst, FormulaScalar, FormulaValue, RangeBounds } from "../../api/formula.js";
import { isOfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { isError, toScalar } from "../formula/coerce.js";
import { boolArg, intArg, textArg } from "../formula/functions/text/args.js";
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

/** An argument the walk could not work out before the move. */
const UNRESOLVED = Symbol("unresolved");
/** An argument the function cannot take, or a written error: it is an error before the move and after. */
const REFUSED = Symbol("refused");

function contains(outer: Dep, inner: Dep): boolean {
  return outer.sheet === inner.sheet && outer.r1 <= inner.r1 && outer.c1 <= inner.c1 && outer.r2 >= inner.r2 && outer.c2 >= inner.c2;
}

/** What a walk over one formula found out. */
interface Finding {
  changed: boolean;
  /** Cells picked at run time from an address that could not be worked out; only the last calculation knows them. */
  unresolved: boolean;
  /** The shifts that leave such a cell where the formula looks for it afterwards. */
  allowed: Set<number>;
}

class PositionWalk {
  readonly found: Finding = { changed: false, unresolved: false, allowed: new Set() };

  constructor(
    private readonly state: WorkbookState,
    private readonly node: CalcNode,
    private readonly sheet: SheetModel,
    private readonly op: StructuralOp,
    private readonly budget: ArgumentBudget,
  ) {}

  /**
   * The value of an argument before the move, as the engine evaluates it:
   * null when it is left out, {@link REFUSED} for a written error,
   * {@link UNRESOLVED} when it cannot be worked out (a typed failure, or more
   * cells than the budget leaves).
   */
  private argValue(ast: FormulaAst | undefined, context: SheetModel): FormulaValue | typeof UNRESOLVED | typeof REFUSED {
    if (ast === undefined || ast.type === "missing") return null;
    if (ast.type === "string" || ast.type === "number" || ast.type === "boolean") return ast.value;
    if (ast.type === "error") return REFUSED;
    const state = this.state;
    const formula = state.formula;
    const functions = functionsOf(state);
    if (formula === null || functions === null) return UNRESOLVED;
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
      return UNRESOLVED;
    }
    return meter.over ? UNRESOLVED : value;
  }

  /**
   * A whole-number argument of OFFSET, converted as OFFSET converts it (the
   * top-left value of a range, then `intArg`): null when it is left out or
   * empty, so that OFFSET takes its default.
   */
  private offsetArg(ast: FormulaAst | undefined, context: SheetModel): number | null | typeof UNRESOLVED | typeof REFUSED {
    const value = this.argValue(ast, context);
    if (value === UNRESOLVED || value === REFUSED) return value;
    const scalar = toScalar(value);
    if (scalar === null) return null;
    // An error may come from working it out without a time or past the budget: it says nothing about the run.
    if (isError(scalar)) return UNRESOLVED;
    const n = intArg(scalar);
    return isError(n) ? REFUSED : n;
  }

  /**
   * An argument of INDIRECT as it arrives: one value. Several values would
   * have INDIRECT called once for each, and an error may come from working it
   * out without a time or past the budget.
   */
  private indirectArg(ast: FormulaAst | undefined, context: SheetModel): FormulaScalar | typeof UNRESOLVED | typeof REFUSED {
    const value = this.argValue(ast, context);
    if (value === UNRESOLVED || value === REFUSED) return value;
    if (value !== null && typeof value === "object" && value.kind === "array" && (value.rows > 1 || value.cols > 1)) return UNRESOLVED;
    const scalar = toScalar(value);
    return isError(scalar) ? UNRESOLVED : scalar;
  }

  /** Cells the formula reads from an address that could not be worked out: judged by the last calculation. */
  private unresolved(shift: number): void {
    this.found.unresolved = true;
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
    else if (name === "INDIRECT") this.indirect(args, context, depth);
  }

  /** OFFSET reads other cells when its base moves and the cells it lands on do not move alike. */
  private offset(args: readonly FormulaAst[], context: SheetModel, depth: number): void {
    const base = args[0];
    if (base === undefined) return;
    const op = this.op;
    const deps = this.refsOn(base, context, depth);
    if (deps.length === 0) return;
    const by = this.offsetArg(op.axis === "row" ? args[1] : args[2], context);
    const givenSize = this.offsetArg(op.axis === "row" ? args[3] : args[4], context);
    for (const dep of deps) {
      const span = spanOf(dep, op);
      const moved = moveSpan(span.low, span.high, op);
      // A base with nothing left of it is #REF!, which OFFSET answers before it looks at the other arguments.
      if (moved === null) {
        this.found.changed = true;
        return;
      }
      // Otherwise an argument OFFSET cannot take makes it the same error before and after.
      if (by === REFUSED || givenSize === REFUSED) continue;
      if (by === UNRESOLVED || givenSize === UNRESOLVED) {
        // Where it lands is known only from the last calculation.
        this.unresolved(moved.low - span.low);
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
  private indirect(args: readonly FormulaAst[], context: SheetModel, depth: number): void {
    const textValue = this.indirectArg(args[0], context);
    const a1Value = this.indirectArg(args[1], context);
    // Either one an error INDIRECT cannot take makes it an error before and after.
    if (textValue === REFUSED || a1Value === REFUSED) return;
    if (textValue === UNRESOLVED || a1Value === UNRESOLVED) {
      this.unresolved(0);
      return;
    }
    // Converted as INDIRECT converts them; what it cannot take, R1C1 text and anything but an address are errors
    // before and after.
    const text = textArg(textValue);
    const a1 = boolArg(a1Value, true);
    if (isError(text) || isError(a1) || !a1) return;
    const trimmed = text.trim();
    if (trimmed.length > MAX_REFERENCE_TEXT) return;
    const ast = trimmed === "" ? null : parseCached(this.state, trimmed.startsWith("=") ? trimmed.slice(1) : trimmed);
    if (ast === null) return;
    // A name follows its cells like any reference, and what in it asks for a position is judged like the formula.
    if (ast.type === "name") {
      this.walk(ast, context, depth);
      return;
    }
    if (ast.type !== "cell" && ast.type !== "range") return;
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
 * calculation such a formula counts as changed (see the file comment).
 */
export function positionsAcrossMove(state: WorkbookState, sheet: SheetModel, op: StructuralOp): (node: CalcNode) => boolean {
  const budget: ArgumentBudget = { cells: MOVE_ARGUMENT_CELLS };
  return (node) => {
    const walk = new PositionWalk(state, node, sheet, op, budget);
    walk.walk(node.ast, node.sheet, 0);
    const found = walk.found;
    if (found.changed) return true;
    if (!found.unresolved) return false;
    // Unresolved: only the last calculation's reads can show it unaffected.
    if (node.readsAll || node.reads === null) return true;
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
