/**
 * Actions that change cells or the sheet: clearing, formatting, filling,
 * inserting and deleting rows and columns, sizes, sorting and filtering.
 * Each is one undo step. A refused edit leaves a notice for the owner.
 */

import {
  type CellAddress,
  type CellRange,
  type CellStylePatch,
  type CellValue,
  type SheetId,
  type StyleId,
  type Workbook,
  getWorkbookInternals,
  isOfficeError,
  xlsx,
} from "../session/engine";
import { MAX_TRANSACTION_CELLS, styleAsPatch } from "../session/edits";
import { forEachStoredCell } from "../session/stored-cells";
import type { EditResult } from "../session/types";
import { CELL_PADDING_PX, cellLook, textWidth } from "./cell-look";
import type { GridContext } from "./context";
import { type FillDirection, type FillSource, fillFromEdge, fillTarget, planFill } from "./fill";
import { MIN_COLUMN_PX, MIN_ROW_PX, pxToColumnWidth, pxToRowHeight } from "./geometry";
import { activeRange, columnFullySelected, rangeCols, rangeRows, rowFullySelected, selectCell } from "./selection";
import { type FilterSpec, type SortKey, filterHiddenRows, planSort } from "./sort-filter";
import { hiddenRows, visibleFillDown, visibleRuns } from "./visible-rows";

/** Most cells one fill, paste or sort writes: what one undo step keeps, so a failed one can be put back. */
export const MAX_ACTION_CELLS = MAX_TRANSACTION_CELLS;
const MAX_STYLE_PATCHES = 4096;
const TOO_MANY = "That is too many cells for one step. Select a smaller area.";

/** Reports a failed edit to the owner. Returns whether the edit worked. */
export function report(ctx: GridContext, result: EditResult): boolean {
  if (result.ok) return true;
  ctx.notice(result.message);
  return false;
}

export interface CellContent {
  value: CellValue;
  /** Formula text without `=`, or null. */
  formula: string | null;
  /** The style the cell should end up with; left as it is when undefined. */
  styleId?: StyleId;
}

/**
 * Returns a function that writes content to cells of one sheet through the
 * workbook's own methods. A formula the engine refuses is stored as its
 * value. Styles are copied by id.
 */
export function createCellWriter(
  workbook: Workbook,
  sheet: SheetId,
  styleAt: (row: number, col: number) => StyleId,
): (row: number, col: number, content: CellContent) => void {
  const patches = new Map<StyleId, CellStylePatch>();
  return (row, col, content) => {
    const address = { row, col };
    if (content.formula !== null) {
      try {
        workbook.setFormula(sheet, address, content.formula);
      } catch (error: unknown) {
        if (!isOfficeError(error, "formula_error")) throw error;
        workbook.setCell(sheet, address, content.value);
      }
    } else {
      workbook.setCell(sheet, address, content.value);
    }
    if (content.styleId === undefined || styleAt(row, col) === content.styleId) return;
    let patch = patches.get(content.styleId);
    if (patch === undefined) {
      if (patches.size >= MAX_STYLE_PATCHES) patches.clear();
      patch = styleAsPatch(workbook.getStyle(content.styleId));
      patches.set(content.styleId, patch);
    }
    workbook.setStyle(sheet, { start: address, end: address }, patch);
  };
}

/** The selected ranges cut to the used area, for edits that only matter where there is content. */
function selectedUsed(ctx: GridContext): CellRange[] {
  return ctx.usedRanges(ctx.selection.ranges);
}

/** Delete or Backspace: empties the selected cells and keeps their formats. Rows a filter hides are left as they are. */
export function clearSelection(ctx: GridContext, what: "contents" | "formats" | "all" = "contents"): void {
  const hidden = hiddenRows(ctx);
  const ranges = selectedUsed(ctx).flatMap((range) => visibleRuns(range, hidden));
  if (ranges.length > 0) report(ctx, ctx.session.clear(ctx.sheet, ranges, what));
}

/** Applies a style patch to the selection. */
export function styleSelection(ctx: GridContext, patch: CellStylePatch): void {
  report(ctx, ctx.session.setStyle(ctx.sheet, ctx.selection.ranges, patch));
}

/** Ctrl+B, Ctrl+I, Ctrl+U: turns the property on unless the active cell already has it. */
export function toggleFormat(ctx: GridContext, which: "bold" | "italic" | "underline"): void {
  const active = ctx.selection.active;
  const style = ctx.session.workbook.getStyle(ctx.session.raw(ctx.sheet, active.row, active.col).styleId);
  styleSelection(ctx, { font: { [which]: !style.font[which] } });
}

function fillReader(ctx: GridContext): (row: number, col: number) => FillSource {
  const sheet = ctx.sheet;
  const dates = new Map<StyleId, boolean>();
  return (row, col) => {
    const raw = ctx.session.raw(sheet, row, col);
    let isDate = false;
    if (typeof raw.value === "number") {
      let known = dates.get(raw.styleId);
      if (known === undefined) {
        known = xlsx.isDateFormat(ctx.session.workbook.getStyle(raw.styleId).numberFormat);
        if (dates.size < MAX_STYLE_PATCHES) dates.set(raw.styleId, known);
      }
      isDate = known;
    }
    return { value: raw.value, formula: raw.formula, isDate };
  };
}

function applyFill(ctx: GridContext, source: CellRange, target: CellRange, direction: FillDirection, series: boolean): boolean {
  // Planning reads every source cell before it writes the target: both count, checked before either is touched.
  if (rangeRows(source) * rangeCols(source) + rangeRows(target) * rangeCols(target) > MAX_ACTION_CELLS) {
    ctx.notice(TOO_MANY);
    return false;
  }
  const sheet = ctx.sheet;
  const session = ctx.session;
  // A filled cell in a row the filter hides would change out of sight: those rows keep their content.
  const hidden = hiddenRows(ctx);
  const edits = planFill(source, target, direction, fillReader(ctx), series).filter((edit) => hidden === null || !hidden.has(edit.row));
  const sources = new Map<string, StyleId>();
  for (const edit of edits) {
    const key = `${edit.from.row},${edit.from.col}`;
    if (!sources.has(key)) sources.set(key, session.raw(sheet, edit.from.row, edit.from.col).styleId);
  }
  return report(
    ctx,
    session.transact("Fill", (tx) => {
      tx.reserve(edits.length);
      const write = createCellWriter(tx.workbook, sheet, (row, col) => session.raw(sheet, row, col).styleId);
      for (const edit of edits) {
        write(edit.row, edit.col, {
          value: edit.value ?? null,
          formula: edit.formula ?? null,
          styleId: sources.get(`${edit.from.row},${edit.from.col}`),
        });
      }
    }),
  );
}

/** Ctrl+D and Ctrl+R: copies the first row down, or the first column to the right, through the selected range. Rows a filter hides are never the source. */
export function fillSelection(ctx: GridContext, direction: "down" | "right"): void {
  const range = activeRange(ctx.selection);
  const bounded = range.kind === "cells" ? range : ctx.usedRanges([range])[0];
  if (bounded === undefined) return;
  const plan = direction === "down" ? visibleFillDown(bounded, hiddenRows(ctx)) : fillFromEdge(bounded, direction);
  if (plan !== null) applyFill(ctx, plan.source, plan.target, direction, false);
}

/** The fill handle was grabbed. */
export function beginFillDrag(ctx: GridContext): void {
  const range = activeRange(ctx.selection);
  if (range.kind !== "cells") return;
  ctx.store.set({ fill: { source: { start: range.start, end: range.end }, target: null, direction: null } });
}

/** The fill handle is over a cell. */
export function dragFillTo(ctx: GridContext, cell: CellAddress): void {
  const fill = ctx.store.getState().fill;
  if (fill === null) return;
  const next = fillTarget(fill.source, cell);
  const same =
    next === null
      ? fill.target === null
      : fill.target !== null &&
        fill.direction === next.direction &&
        fill.target.start.row === next.target.start.row &&
        fill.target.start.col === next.target.start.col &&
        fill.target.end.row === next.target.end.row &&
        fill.target.end.col === next.target.end.col;
  if (same) return;
  ctx.store.set({ fill: { source: fill.source, target: next?.target ?? null, direction: next?.direction ?? null } });
  if (next !== null) ctx.reveal(cell);
}

/** The fill handle was released: continue the pattern of the source over the dragged cells and select them all. */
export function endFillDrag(ctx: GridContext): void {
  const fill = ctx.store.getState().fill;
  ctx.store.set({ fill: null });
  if (fill === null || fill.target === null || fill.direction === null) return;
  if (!applyFill(ctx, fill.source, fill.target, fill.direction, true)) return;
  const merges = ctx.info().mergedRanges;
  const start = { row: Math.min(fill.source.start.row, fill.target.start.row), col: Math.min(fill.source.start.col, fill.target.start.col) };
  const end = { row: Math.max(fill.source.end.row, fill.target.end.row), col: Math.max(fill.source.end.col, fill.target.end.col) };
  const base = selectCell(fill.source.start, merges);
  ctx.select({ ranges: [{ start, end, kind: "cells" }], active: base.active, anchor: start, focus: end }, null);
}

function dropFilter(ctx: GridContext): void {
  if (ctx.view.filter !== null) ctx.store.setView(ctx.sheet, { filter: null });
}

/** Inserts as many rows as the selection spans, above or below it. */
export function insertRows(ctx: GridContext, where: "before" | "after"): void {
  const range = activeRange(ctx.selection);
  if (range.kind === "cols" || range.kind === "all") return;
  dropFilter(ctx);
  report(ctx, ctx.session.insertRows(ctx.sheet, where === "before" ? range.start.row : range.end.row + 1, rangeRows(range)));
}

export function deleteRows(ctx: GridContext): void {
  const range = activeRange(ctx.selection);
  if (range.kind === "cols" || range.kind === "all") return;
  dropFilter(ctx);
  if (report(ctx, ctx.session.deleteRows(ctx.sheet, range.start.row, rangeRows(range)))) {
    ctx.select(selectCell({ row: range.start.row, col: ctx.selection.active.col }, ctx.info().mergedRanges));
  }
}

export function insertColumns(ctx: GridContext, where: "before" | "after"): void {
  const range = activeRange(ctx.selection);
  if (range.kind === "rows" || range.kind === "all") return;
  // The filter names its columns by position: a new column would point it at the wrong data.
  dropFilter(ctx);
  report(ctx, ctx.session.insertColumns(ctx.sheet, where === "before" ? range.start.col : range.end.col + 1, rangeCols(range)));
}

export function deleteColumns(ctx: GridContext): void {
  const range = activeRange(ctx.selection);
  if (range.kind === "rows" || range.kind === "all") return;
  dropFilter(ctx);
  if (report(ctx, ctx.session.deleteColumns(ctx.sheet, range.start.col, rangeCols(range)))) {
    ctx.select(selectCell({ row: ctx.selection.active.row, col: range.start.col }, ctx.info().mergedRanges));
  }
}

const MAX_SIZED = 2000;

/** The rows or columns a resize applies to: the dragged one, or every fully selected one when it is among them. */
function sizeTargets(ctx: GridContext, axis: "row" | "col", index: number): number[] {
  const selection = ctx.selection;
  const selected = axis === "row" ? rowFullySelected(selection, index) : columnFullySelected(selection, index);
  if (!selected) return [index];
  const limit = axis === "row" ? ctx.layout().extent.rows : ctx.layout().extent.cols;
  const targets = new Set<number>([index]);
  for (const range of selection.ranges) {
    if (range.kind !== (axis === "row" ? "rows" : "cols") && range.kind !== "all") continue;
    const first = axis === "row" ? range.start.row : range.start.col;
    const last = Math.min(axis === "row" ? range.end.row : range.end.col, limit - 1);
    for (let at = first; at <= last && targets.size < MAX_SIZED; at++) targets.add(at);
  }
  return [...targets];
}

/** Sets the width of a column, and of the other fully selected columns, in pixels. */
export function resizeColumn(ctx: GridContext, col: number, px: number): void {
  const width = pxToColumnWidth(Math.max(MIN_COLUMN_PX, Math.round(px)));
  report(ctx, ctx.session.setColumnWidths(ctx.sheet, sizeTargets(ctx, "col", col), width));
}

export function resizeRow(ctx: GridContext, row: number, px: number): void {
  const height = pxToRowHeight(Math.max(MIN_ROW_PX, Math.round(px)));
  report(ctx, ctx.session.setRowHeights(ctx.sheet, sizeTargets(ctx, "row", row), height));
}

const AUTOFIT_ROWS = 20_000;
/** Most stored cells one fit looks at, over all its columns. */
const AUTOFIT_CELLS = 400_000;
const AUTOFIT_MAX_PX = 600;
const AUTOFIT_MIN_PX = 24;

/**
 * The width in pixels that shows every value of each column, or null for a
 * column with nothing in it. Looks at the stored cells of the first rows of
 * the used area, not at every position: the columns of a mostly empty sheet
 * can span millions of them.
 */
export function fittingColumnWidths(ctx: GridContext, cols: readonly number[]): Map<number, number | null> {
  const widths = new Map<number, number | null>(cols.map((col) => [col, null]));
  const sheet = ctx.sheet;
  const used = ctx.info().dimensions;
  if (used === null || cols.length === 0) return widths;
  const merges = ctx.info().mergedRanges;
  let first = used.end.col;
  let last = used.start.col;
  for (const col of cols) {
    first = Math.min(first, col);
    last = Math.max(last, col);
  }
  const range: CellRange = {
    start: { row: used.start.row, col: Math.max(first, used.start.col) },
    end: { row: Math.min(used.end.row, used.start.row + AUTOFIT_ROWS - 1), col: Math.min(last, used.end.col) },
  };
  if (range.start.col > range.end.col) return widths;
  const widest = new Map<number, number>();
  let looked = 0;
  forEachStoredCell(getWorkbookInternals(ctx.session.workbook), sheet, range, (row, col) => {
    if (!widths.has(col) || ctx.session.isBlank(sheet, row, col)) return true;
    if (++looked > AUTOFIT_CELLS) return false;
    // A merged cell takes its width from several columns; it does not drive this one.
    if (merges.some((merge) => row >= merge.start.row && row <= merge.end.row && col >= merge.start.col && col <= merge.end.col)) return true;
    const cell = ctx.session.cell(sheet, row, col);
    const look = cellLook(ctx.session.workbook.getStyle(cell.styleId), cell.value);
    const longest = look.wrap ? cell.display : cell.display.split("\n").reduce((a, b) => (a.length >= b.length ? a : b), "");
    widest.set(col, Math.max(widest.get(col) ?? 0, textWidth(longest, look)));
    return true;
  });
  for (const [col, px] of widest) {
    if (px > 0) widths.set(col, Math.min(AUTOFIT_MAX_PX, Math.max(AUTOFIT_MIN_PX, px + CELL_PADDING_PX + 4)));
  }
  return widths;
}

/** Double click on a column edge: fits the column (and the other selected columns) to its content. */
export function autoFitColumn(ctx: GridContext, col: number): void {
  const widths = fittingColumnWidths(ctx, sizeTargets(ctx, "col", col));
  const sheet = ctx.sheet;
  report(
    ctx,
    ctx.session.transact("Fit column", (tx) => {
      for (const [target, px] of widths) tx.setColumnWidths(sheet, [target], px === null ? null : pxToColumnWidth(px));
    }),
  );
}

/** Double click on a row edge: back to the default height. */
export function autoFitRow(ctx: GridContext, row: number): void {
  report(ctx, ctx.session.setRowHeights(ctx.sheet, sizeTargets(ctx, "row", row), null));
}

/** Most filled cells the search for a block of data indexes; a sheet holding more is too large to search. */
export const MAX_REGION_CELLS = 1_000_000;

/** Index of the first entry of a sorted list that is at least `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** True when a sorted list holds a value from `from` to `to`. */
function anyBetween(sorted: readonly number[] | undefined, from: number, to: number): boolean {
  if (sorted === undefined) return false;
  const at = lowerBound(sorted, from);
  return at < sorted.length && (sorted[at] as number) <= to;
}

/**
 * The block of data around a cell: grown until an empty row and column
 * surround it, or null when the sheet holds too many cells to search.
 *
 * The filled cells are indexed once from the cells the sheet stores, so each
 * growth step asks the index instead of reading the edges again: a diagonal
 * of ten thousand values would otherwise cost about a hundred million reads.
 */
export function currentRegion(ctx: GridContext, cell: CellAddress): CellRange | null {
  const sheet = ctx.sheet;
  const used = ctx.info().dimensions;
  let region: CellRange = { start: { ...cell }, end: { ...cell } };
  if (used === null) return region;
  const byRow = new Map<number, number[]>();
  const byCol = new Map<number, number[]>();
  let filled = 0;
  const complete = forEachStoredCell(getWorkbookInternals(ctx.session.workbook), sheet, used, (row, col) => {
    if (ctx.session.isBlank(sheet, row, col)) return true;
    if (++filled > MAX_REGION_CELLS) return false;
    let cols = byRow.get(row);
    if (cols === undefined) byRow.set(row, (cols = []));
    cols.push(col);
    let rows = byCol.get(col);
    if (rows === undefined) byCol.set(col, (rows = []));
    rows.push(row);
    return true;
  });
  if (!complete) return null;
  for (const list of byRow.values()) list.sort((a, b) => a - b);
  for (const list of byCol.values()) list.sort((a, b) => a - b);
  // Each step grows the block by one row or column, so the steps stay below the rows plus the columns of a sheet.
  for (let guard = 0; guard < 2_200_000; guard++) {
    const { start, end } = region;
    if (anyBetween(byRow.get(start.row - 1), start.col - 1, end.col + 1)) region = { start: { row: start.row - 1, col: start.col }, end };
    else if (anyBetween(byRow.get(end.row + 1), start.col - 1, end.col + 1)) region = { start, end: { row: end.row + 1, col: end.col } };
    else if (anyBetween(byCol.get(start.col - 1), start.row - 1, end.row + 1)) region = { start: { row: start.row, col: start.col - 1 }, end };
    else if (anyBetween(byCol.get(end.col + 1), start.row - 1, end.row + 1)) region = { start, end: { row: end.row, col: end.col + 1 } };
    else break;
  }
  return region;
}

/** The range a sort or filter works on: the selected range, or the block of data around the active cell. Null when that block is too large to find. */
export function dataRange(ctx: GridContext): CellRange | null {
  const range = activeRange(ctx.selection);
  if (range.kind === "cells" && (rangeRows(range) > 1 || rangeCols(range) > 1)) return { start: range.start, end: range.end };
  if (range.kind !== "cells") return ctx.usedRanges([range])[0] ?? { start: ctx.selection.active, end: ctx.selection.active };
  return currentRegion(ctx, ctx.selection.active);
}

/** True when the first row of a range reads as labels over data: all text, above at least one number or logical value. */
export function looksLikeHeader(ctx: GridContext, range: CellRange): boolean {
  if (range.end.row <= range.start.row) return false;
  const sheet = ctx.sheet;
  let labels = 0;
  let data = false;
  for (let col = range.start.col; col <= range.end.col; col++) {
    const top = ctx.session.raw(sheet, range.start.row, col).value;
    if (top === null) continue;
    if (typeof top !== "string") return false;
    labels++;
    const below = ctx.session.raw(sheet, range.start.row + 1, col).value;
    if (typeof below === "number" || typeof below === "boolean") data = true;
  }
  return labels > 0 && data;
}

/** Sorts the rows of a range. Without `hasHeader` the first row is kept when it reads as labels. */
export function sortRange(ctx: GridContext, range: CellRange, keys: readonly SortKey[], hasHeader?: boolean): boolean {
  const sheet = ctx.sheet;
  const session = ctx.session;
  const header = hasHeader ?? looksLikeHeader(ctx, range);
  const plan = planSort(range, keys, header, (row, col) => session.raw(sheet, row, col));
  if (plan === null) {
    ctx.notice(TOO_MANY);
    return false;
  }
  if (plan.length === 0) return true;
  const sorted = report(
    ctx,
    session.transact("Sort", (tx) => {
      tx.reserve(plan.length);
      const write = createCellWriter(tx.workbook, sheet, (row, col) => session.raw(sheet, row, col).styleId);
      for (const entry of plan) write(entry.row, entry.col, entry.cell);
    }),
  );
  // A sort moves records between rows: the filter hides again the rows that hold what it rejects.
  if (sorted) refreshFilter(ctx);
  return sorted;
}

/** Sorts the data around the active cell by the active cell's column. */
export function sortSelection(ctx: GridContext, descending: boolean): void {
  const range = dataRange(ctx);
  if (range === null) {
    ctx.notice(TOO_MANY);
    return;
  }
  const col = Math.min(range.end.col, Math.max(range.start.col, ctx.selection.active.col));
  sortRange(ctx, range, [{ col, descending }]);
}

/** Hides the rows a filter rejects, in this view only. */
export function applyFilter(ctx: GridContext, spec: FilterSpec | null): void {
  const sheet = ctx.sheet;
  if (spec === null || spec.criteria.length === 0) {
    dropFilter(ctx);
    return;
  }
  const hidden = filterHiddenRows(spec, (row, col) => ctx.session.cell(sheet, row, col).display);
  ctx.store.setView(sheet, { filter: { spec, hidden: [...hidden].sort((a, b) => a - b) } });
  const active = ctx.selection.active;
  if (hidden.has(active.row)) ctx.select(selectCell({ row: spec.range.start.row, col: active.col }, ctx.info().mergedRanges));
}

/** Applies the filter again after the workbook changed. */
export function refreshFilter(ctx: GridContext): void {
  const filter = ctx.view.filter;
  if (filter !== null) applyFilter(ctx, filter.spec);
}

/** Keeps only the rows whose value in the active column equals the active cell's. */
export function filterByActiveValue(ctx: GridContext): void {
  const active = ctx.selection.active;
  const range = dataRange(ctx);
  if (range === null) {
    ctx.notice(TOO_MANY);
    return;
  }
  if (range.end.row <= range.start.row) return;
  const display = ctx.session.cell(ctx.sheet, active.row, active.col).display;
  const others = (ctx.view.filter?.spec.criteria ?? []).filter((criterion) => criterion.col !== active.col);
  applyFilter(ctx, { range: ctx.view.filter?.spec.range ?? range, criteria: [...others, { col: active.col, values: [display] }] });
}
