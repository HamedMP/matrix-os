/** Moving and growing the selection in response to keys and the mouse. */

import type { CellAddress, CellRange } from "../session/engine";
import type { GridContext } from "./context";
import { type Direction, jump, lastUsedCell, moveRows, step } from "./navigation";
import {
  type SelectMode,
  addCell,
  extendTo,
  isSingleCell,
  moveWithinSelection,
  selectAll,
  selectCell,
  selectColumns,
  selectRows,
} from "./selection";
import { pageRows } from "./viewport";

/** Arrow keys: one cell, or to the edge of the data with `jump`; `extend` grows the range instead of moving it. */
export function moveActive(ctx: GridContext, direction: Direction, options: { extend?: boolean; jump?: boolean } = {}): void {
  const nav = ctx.navContext();
  const selection = ctx.selection;
  const from = options.extend === true ? selection.focus : selection.active;
  const target = options.jump === true ? jump(from, direction, nav) : step(from, direction, nav);
  if (options.extend === true) ctx.select(extendTo(selection, target, nav.merges), target);
  else ctx.select(selectCell(target, nav.merges));
}

/** Tab and Enter: through the cells of a selected range, or one cell on. */
export function advance(ctx: GridContext, direction: Direction): void {
  const nav = ctx.navContext();
  const selection = ctx.selection;
  if (!isSingleCell(selection, nav.merges)) {
    const next = moveWithinSelection(selection, direction, nav.merges, nav);
    ctx.select(next, next.active);
    return;
  }
  ctx.select(selectCell(step(selection.active, direction, nav), nav.merges));
}

export function pageMove(ctx: GridContext, direction: "up" | "down", extend: boolean): void {
  const nav = ctx.navContext();
  const selection = ctx.selection;
  const rows = pageRows(ctx.layout().viewport) * (direction === "down" ? 1 : -1);
  const target = moveRows(extend ? selection.focus : selection.active, rows, nav);
  if (extend) ctx.select(extendTo(selection, target, nav.merges), target);
  else ctx.select(selectCell(target, nav.merges));
}

function jumpTo(ctx: GridContext, target: CellAddress, extend: boolean): void {
  const merges = ctx.info().mergedRanges;
  if (extend) ctx.select(extendTo(ctx.selection, target, merges), target);
  else ctx.select(selectCell(target, merges));
}

/** Home: the first column of the row; with `sheet`, the first cell of the sheet. */
export function homeMove(ctx: GridContext, extend: boolean, sheet: boolean): void {
  const from = extend ? ctx.selection.focus : ctx.selection.active;
  jumpTo(ctx, sheet ? { row: 0, col: 0 } : { row: from.row, col: 0 }, extend);
}

/** Ctrl+End: the last used cell. */
export function endMove(ctx: GridContext, extend: boolean): void {
  jumpTo(ctx, lastUsedCell(ctx.navContext()), extend);
}

export function selectEverything(ctx: GridContext): void {
  ctx.select(selectAll(ctx.selection.active), null);
}

export function selectActiveRow(ctx: GridContext): void {
  const active = ctx.selection.active;
  ctx.select({ ...selectRows(null, active.row), active }, null);
}

export function selectActiveColumn(ctx: GridContext): void {
  const active = ctx.selection.active;
  ctx.select({ ...selectColumns(null, active.col), active }, null);
}

/** A click or drag on a cell. */
export function pickCell(ctx: GridContext, cell: CellAddress, mode: SelectMode): void {
  const merges = ctx.info().mergedRanges;
  if (mode === "extend") ctx.select(extendTo(ctx.selection, cell, merges), cell);
  else if (mode === "add") ctx.select(addCell(ctx.selection, cell, merges), cell);
  else ctx.select(selectCell(cell, merges), cell);
}

/** A click or drag on a row header. The active cell is the first visible cell of the row. */
export function pickRow(ctx: GridContext, row: number, mode: SelectMode): void {
  const first = ctx.layout().viewport.visibleCols.start;
  ctx.select(selectRows(ctx.selection, row, mode, Math.max(0, first)), null);
}

export function pickColumn(ctx: GridContext, col: number, mode: SelectMode): void {
  const first = ctx.layout().viewport.visibleRows.start;
  ctx.select(selectColumns(ctx.selection, col, mode, Math.max(0, first)), null);
}

/** Selects a range and brings it into view (the name box, undo, a review jump). */
export function goToRange(ctx: GridContext, range: CellRange): void {
  const merges = ctx.info().mergedRanges;
  const start = selectCell(range.start, merges);
  const selection = range.start.row === range.end.row && range.start.col === range.end.col ? start : extendTo(start, range.end, merges);
  ctx.select(selection, null);
  ctx.reveal(range.end);
  ctx.reveal(range.start);
}
