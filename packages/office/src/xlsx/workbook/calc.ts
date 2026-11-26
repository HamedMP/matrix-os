/**
 * Calculation: evaluates out-of-date formula cells in dependency order.
 *
 * The formula engine evaluates one formula at a time and reads cells through
 * a `CellProvider`; `calc-run.ts` decides which formulas to evaluate and
 * stores the results as the cells' cached values. This module starts a run
 * and answers what a formula reads and what reads a cell.
 */

import type { CellAddress, RecalcOptions, RecalcResult, SheetCellRef, SheetRangeRef } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { type CalcGraph, type CalcNode, type Dep, buildGraph, collectDeps } from "./calc-graph.js";
import { orderGraph } from "./calc-order.js";
import { Run, TRACE_LIMIT, addTo, isEmpty } from "./calc-run.js";
import { findCell } from "./cells.js";
import { type SheetModel, type WorkbookState, cellKey } from "./model.js";
import { parseCached } from "./state.js";

const DEFAULT_MAX_CELLS = 200_000;

/** True when the workbook has edits that formulas have not seen yet, or formulas a bounded run left. */
export function needsRecalc(state: WorkbookState): boolean {
  if (state.calc.all || state.calc.folded.size > 0) return true;
  for (const edited of state.calc.edited.values()) if (edited.size > 0) return true;
  for (const pending of state.calc.pending.values()) if (pending.size > 0) return true;
  return false;
}

function graphOf(state: WorkbookState): CalcGraph {
  let graph = state.calc.graph as CalcGraph | null;
  if (graph === null) {
    graph = buildGraph(state);
    state.calc.graph = graph;
  }
  return graph;
}

function bound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Calculates out-of-date formulas. `explicit` is false for the run `save`
 * makes on its own, which leaves volatile formulas alone unless an input of
 * theirs changed.
 */
export function recalc(state: WorkbookState, options: RecalcOptions | undefined, explicit: boolean): RecalcResult {
  const calc = state.calc;
  if (options?.now !== undefined) calc.lastNow = options.now;
  if (state.formula === null) {
    calc.edited.clear();
    calc.folded.clear();
    calc.pending.clear();
    calc.all = false;
    return { changed: [], circular: [], complete: true };
  }
  const maxCells = bound(options?.maxCells, DEFAULT_MAX_CELLS);
  // The order is found without recursion, so a chain may be as long as the sheet; a caller can still bound it.
  const maxDepth = options?.maxDepth === undefined ? Number.POSITIVE_INFINITY : Math.max(1, bound(options.maxDepth, Number.POSITIVE_INFINITY));
  const graph = graphOf(state);
  let order = graph.order;
  let blocked: CalcNode[] = [];
  if (order === null) {
    const ordered = orderGraph(graph, maxDepth);
    order = ordered.order;
    blocked = ordered.blocked;
    if (blocked.length === 0) graph.order = order;
  }
  if (calc.onLoad) {
    calc.onLoad = false;
    calc.all = true;
  }
  let editedCount = 0;
  for (const edited of calc.edited.values()) editedCount += edited.size;
  if (calc.all) calc.pending.clear();
  // A run that takes up what a bounded one left does not start the volatile formulas over.
  const resumed = !isEmpty(calc.pending);
  const all = calc.all || editedCount > TRACE_LIMIT;
  const run = new Run(state, graph, order, options?.now ?? calc.lastNow, maxCells, explicit && !resumed, all);
  let complete = run.run();
  if (blocked.length > 0) {
    complete = false;
    for (const node of blocked) addTo(calc.pending, node.sheet, cellKey(node.row, node.col));
  }
  calc.edited.clear();
  calc.folded.clear();
  calc.all = false;
  if (complete) calc.pending.clear();
  return { changed: run.changed, circular: run.circular, complete };
}

export function precedents(state: WorkbookState, sheet: SheetModel, address: CellAddress): SheetRangeRef[] {
  const cell = findCell(sheet, address.row, address.col);
  if (cell === undefined || cell.formula === null) return [];
  const ast = parseCached(state, cell.formula);
  if (ast === null) return [];
  const deps: Dep[] = [];
  collectDeps(state, ast, sheet, 0, deps);
  return deps.map((dep) => ({ sheet: dep.sheet.id, start: { row: dep.r1, col: dep.c1 }, end: { row: dep.r2, col: dep.c2 } }));
}

export function dependents(state: WorkbookState, sheet: SheetModel, address: CellAddress): SheetCellRef[] {
  if (state.formula === null) return [];
  const found: SheetCellRef[] = [];
  for (const node of graphOf(state).nodes) {
    for (const dep of node.deps) {
      if (dep.sheet === sheet && address.row >= dep.r1 && address.row <= dep.r2 && address.col >= dep.c1 && address.col <= dep.c2) {
        found.push({ sheet: node.sheet.id, row: node.row, col: node.col });
        break;
      }
    }
  }
  const position = new Map(state.sheets.map((entry, index) => [entry.id, index] as const));
  return found.sort(
    (a, b) => (position.get(a.sheet) ?? 0) - (position.get(b.sheet) ?? 0) || a.row - b.row || a.col - b.col,
  );
}

/** Checks formula text given by a caller. Throws `formula_error` when it does not parse. */
export function checkFormula(state: WorkbookState, text: string): void {
  if (text.trim() === "") throw new OfficeError("formula_error", "the formula is empty");
  if (state.formula === null) return;
  state.formula.parseFormula(text);
}
