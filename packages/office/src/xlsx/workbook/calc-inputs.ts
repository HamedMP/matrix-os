/**
 * What changed for the formulas since the last calculation: the cells edited
 * one by one, and the formulas that need a time whose inputs changed in ways
 * those marks no longer show.
 *
 * A run without a time calculates a formula that needs one (TODAY, NOW) only
 * when what it reads changed; otherwise it keeps the date it has. While edits
 * are marked one by one the run sees that from the marks. When the marks are
 * dropped (past the trace limit, or a run a bound stopped) or a change is no
 * edit of a cell (rows deleted, a sheet removed, a name changed), the formulas that need a time and read what
 * changed are noted in `calc.clockInputs` first. A move also notes those whose answer depends on where a
 * reference points (`calc-positions.ts`). That set holds formula
 * cells of the graph only, so it is bounded by the formula cells of the
 * workbook, which `maxCells` bounds.
 */

import type { CellRange } from "../../api/xlsx.js";
import { type CalcGraph, type CalcNode, type Dep, buildGraph, collectDeps } from "./calc-graph.js";
import { type CellRec, type SheetModel, type WorkbookState, cellKey } from "./model.js";
import { type StructuralOp, moveSpan } from "./refs-rewrite.js";

export type CellSets = Map<SheetModel, Set<number>>;

export function isEmpty(sets: CellSets): boolean {
  for (const set of sets.values()) if (set.size > 0) return false;
  return true;
}

export function addTo(sets: CellSets, sheet: SheetModel, key: number): void {
  let set = sets.get(sheet);
  if (set === undefined) {
    set = new Set();
    sets.set(sheet, set);
  }
  set.add(key);
}

/** True for an array formula that fills cells besides its own. */
export function fillsRange(node: CalcNode): boolean {
  const spill = node.spill;
  return spill !== null && (spill.end.row > spill.start.row || spill.end.col > spill.start.col);
}

function spillDep(node: CalcNode): Dep {
  const spill = node.spill as CellRange;
  return { sheet: node.sheet, r1: spill.start.row, c1: spill.start.col, r2: spill.end.row, c2: spill.end.col };
}

export function touches(dep: Dep, changed: CellSets): boolean {
  const set = changed.get(dep.sheet);
  if (set === undefined || set.size === 0) return false;
  const area = (dep.r2 - dep.r1 + 1) * (dep.c2 - dep.c1 + 1);
  if (area <= set.size) {
    for (let r = dep.r1; r <= dep.r2; r++) for (let c = dep.c1; c <= dep.c2; c++) if (set.has(cellKey(r, c))) return true;
    return false;
  }
  for (const key of set) {
    const col = key % 16384;
    const row = (key - col) / 16384;
    if (row >= dep.r1 && row <= dep.r2 && col >= dep.c1 && col <= dep.c2) return true;
  }
  return false;
}

/**
 * True when a cell the formula reads, a cell of the range it fills or a cell
 * it read at run time last time satisfies `hit`. Its own cell alone does not
 * count: a formula typed into it has no value yet and is calculated anyway.
 */
function readsWhere(node: CalcNode, hit: (dep: Dep) => boolean): boolean {
  for (const dep of node.deps) if (hit(dep)) return true;
  if (fillsRange(node) && hit(spillDep(node))) return true;
  if (!node.dynamic || node.reads === null) return false;
  if (node.readsAll) return true;
  for (const dep of node.reads) if (hit(dep)) return true;
  return false;
}

/** True when the formula reads, or fills, a cell in `sets`. See {@link readsWhere}. */
export function readsAny(node: CalcNode, sets: CellSets): boolean {
  if (isEmpty(sets)) return false;
  return readsWhere(node, (dep) => touches(dep, sets));
}

/** True when the formula reads, or fills, a cell of `sheet`. */
export function readsSheet(node: CalcNode, sheet: SheetModel): boolean {
  return readsWhere(node, (dep) => dep.sheet === sheet);
}

/**
 * True when a row or column move on `sheet` changes which cells the formula
 * reads, beyond moving them: a range that loses cells or gains new ones, or a
 * reference to a deleted cell. A range that only moves reads the same cells.
 */
export function readsAcrossMove(node: CalcNode, sheet: SheetModel, op: StructuralOp): boolean {
  return readsWhere(node, (dep) => {
    if (dep.sheet !== sheet) return false;
    const low = op.axis === "row" ? dep.r1 : dep.c1;
    const high = op.axis === "row" ? dep.r2 : dep.c2;
    const moved = moveSpan(low, high, op);
    return moved === null || moved.high - moved.low !== high - low;
  });
}

export function graphOf(state: WorkbookState): CalcGraph {
  let graph = state.calc.graph as CalcGraph | null;
  if (graph === null) {
    graph = buildGraph(state);
    state.calc.graph = graph;
    state.calc.clocks = graph.clock;
  }
  return graph;
}

/** The formulas that need a time, from the graph or the nodes kept since it was dropped. */
function clocksOf(state: WorkbookState): readonly CalcNode[] {
  const graph = state.calc.graph as CalcGraph | null;
  if (graph !== null) return graph.clock;
  const kept = state.calc.clocks as CalcNode[] | null;
  return kept ?? graphOf(state).clock;
}

/**
 * Notes, in `calc.clockInputs`, the formulas that need a time, hold a value
 * and satisfy `changed`, keeping those noted before. Called before what tells
 * the next run about a change is dropped or no longer matches the cells. The
 * set is rebuilt from the formulas of the graph, so it never holds more
 * entries than the workbook has formula cells; cells of `gone` are left out.
 */
export function noteClockInputs(state: WorkbookState, changed: (node: CalcNode) => boolean, gone: SheetModel | null = null): void {
  if (state.formula === null) return;
  const before = state.calc.clockInputs;
  const noted = new Set<CellRec>();
  for (const node of clocksOf(state)) {
    // A formula without a value is calculated anyway; a node whose cell holds another formula is out of date.
    if (node.sheet === gone || node.cell.value === null || node.cell.formula !== node.formula) continue;
    if (before.has(node.cell) || changed(node)) noted.add(node.cell);
  }
  state.calc.clockInputs = noted;
}

function sameDeps(a: readonly Dep[], b: readonly Dep[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Dep;
    const y = b[i] as Dep;
    if (x.sheet !== y.sheet || x.r1 !== y.r1 || x.c1 !== y.c1 || x.r2 !== y.r2 || x.c2 !== y.c2) return false;
  }
  return true;
}

/**
 * Makes `change` (a defined name set or removed) and notes the formulas that
 * need a time whose names now lead to other cells than before.
 */
export function noteNameChange<T>(state: WorkbookState, change: () => T): T {
  if (state.formula === null) return change();
  const known = clocksOf(state);
  const result = change();
  const moved = new Set<CellRec>();
  for (const node of known) {
    if (node.cell.value === null || node.cell.formula !== node.formula) continue;
    const deps: Dep[] = [];
    collectDeps(state, node.ast, node.sheet, 0, deps);
    if (!sameDeps(deps, node.deps)) moved.add(node.cell);
  }
  if (moved.size > 0) noteClockInputs(state, (node) => moved.has(node.cell));
  return result;
}
