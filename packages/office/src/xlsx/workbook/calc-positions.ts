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
 */

import type { FormulaAst } from "../../api/formula.js";
import { type CalcNode, type Dep, MAX_NAME_DEPTH, collectDeps, pushChildren } from "./calc-graph.js";
import type { SheetModel, WorkbookState } from "./model.js";
import { lookupName } from "./names.js";
import { type StructuralOp, movePoint, moveSpan } from "./refs-rewrite.js";
import { parseCached } from "./state.js";

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

/** A whole number written in the formula (`3`, `-4`), `fallback` for an absent or empty argument, or null. */
function literalInt(ast: FormulaAst | undefined, fallback: number): number | null {
  if (ast === undefined || ast.type === "missing") return fallback;
  let inner: FormulaAst = ast;
  while (inner.type === "paren") inner = inner.inner;
  if (inner.type === "number") return Math.trunc(inner.value);
  if (inner.type === "unary" && inner.op === "-" && inner.operand.type === "number") return -Math.trunc(inner.operand.value);
  return null;
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
  ) {}

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
    const by = literalInt(op.axis === "row" ? args[1] : args[2], 0);
    for (const dep of this.refsOn(base, context, depth)) {
      const span = spanOf(dep, op);
      const moved = moveSpan(span.low, span.high, op);
      if (moved === null) {
        this.found.changed = true;
        return;
      }
      const size = literalInt(op.axis === "row" ? args[3] : args[4], span.high - span.low + 1);
      if (by === null || size === null) {
        // Where it lands is known only from the last calculation.
        this.found.needsReads = true;
        this.found.allowed.add(moved.low - span.low);
        continue;
      }
      // A height or width below one is #REF! wherever the base is.
      if (size < 1) continue;
      const low = span.low + by;
      const next = moved.low + by;
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
    const text = args[0];
    const a1 = args[1];
    if (text?.type !== "string" || (a1 !== undefined && a1.type !== "missing" && !(a1.type === "boolean" && a1.value))) {
      this.found.needsReads = true;
      this.found.allowed.add(0);
      return;
    }
    const trimmed = text.value.trim();
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
 * True when a row or column move on `sheet` changes the answer the formula
 * gets from where a reference points: ROW, COLUMN, ROWS or COLUMNS of a
 * reference the move shifts or resizes along that axis, ROW() or COLUMN() of
 * a formula the move shifts, OFFSET from a base whose target does not move
 * alike, INDIRECT of an address whose cells moved away. Cells picked at run
 * time from an address the formula does not hold are judged by the cells
 * the last calculation read; without one the formula counts as changed.
 */
export function readsPositionAcrossMove(state: WorkbookState, node: CalcNode, sheet: SheetModel, op: StructuralOp): boolean {
  const walk = new PositionWalk(state, node, sheet, op);
  walk.walk(node.ast, node.sheet, 0);
  const found = walk.found;
  if (found.changed) return true;
  if (!found.needsReads) return false;
  if (node.reads === null || node.readsAll) return true;
  for (const read of node.reads) {
    // A cell the formula names follows the move like the reference does.
    if (read.sheet !== sheet || node.deps.some((dep) => contains(dep, read))) continue;
    const span = spanOf(read, op);
    const moved = moveSpan(span.low, span.high, op);
    if (moved === null || moved.high - moved.low !== span.high - span.low || !found.allowed.has(moved.low - span.low)) return true;
  }
  return false;
}
