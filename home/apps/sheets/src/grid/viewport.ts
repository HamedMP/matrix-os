/**
 * Which cells are on screen, and where.
 *
 * The cell area is split by the frozen panes into up to four parts: the
 * frozen corner, frozen rows (scroll sideways), frozen columns (scroll up and
 * down) and the main part. `scrollTop` and `scrollLeft` are offsets of the
 * main part in sheet pixels; the frozen parts ignore the scroll in their
 * fixed direction.
 *
 * All positions returned here are relative to the top-left corner of the cell
 * area (below the column headers, right of the row headers).
 */

import type { CellAddress, CellRange } from "../session/engine";
import type { Axis, PixelRect, SheetAxes } from "./geometry";

export interface ViewportInput {
  axes: SheetAxes;
  frozenRows: number;
  frozenCols: number;
  scrollTop: number;
  scrollLeft: number;
  /** Size of the cell area in pixels. */
  width: number;
  height: number;
  /** Extra rows and columns rendered around the visible ones. Default 2. */
  overscan?: number;
}

/** Inclusive run of indexes. Empty when `end < start`. */
export interface Span {
  start: number;
  end: number;
}

export interface Viewport {
  /** Pixel size of the frozen rows and columns. */
  frozenHeight: number;
  frozenWidth: number;
  frozenRows: Span;
  frozenCols: Span;
  /** Scrolling rows and columns to render, with overscan. */
  rows: Span;
  cols: Span;
  /** Scrolling rows and columns that are at least partly visible. */
  visibleRows: Span;
  visibleCols: Span;
  scrollTop: number;
  scrollLeft: number;
}

const EMPTY: Span = { start: 0, end: -1 };

export function spanLength(span: Span): number {
  return Math.max(0, span.end - span.start + 1);
}

function visibleSpan(axis: Axis, frozen: number, frozenSize: number, scroll: number, size: number): Span {
  const room = size - frozenSize;
  if (room <= 0 || frozen >= axis.count) return EMPTY;
  const first = Math.max(frozen, axis.indexAt(frozenSize + scroll));
  const last = Math.max(first, axis.indexAt(frozenSize + scroll + room - 1));
  return { start: first, end: last };
}

function widen(span: Span, by: number, min: number, max: number): Span {
  if (span.end < span.start) return span;
  return { start: Math.max(min, span.start - by), end: Math.min(max, span.end + by) };
}

/** The largest scroll offsets that still fill the cell area. */
export function maxScroll(input: Pick<ViewportInput, "axes" | "width" | "height">): { top: number; left: number } {
  return {
    top: Math.max(0, input.axes.rows.total - input.height),
    left: Math.max(0, input.axes.cols.total - input.width),
  };
}

export function computeViewport(input: ViewportInput): Viewport {
  const { rows, cols } = input.axes;
  const overscan = input.overscan ?? 2;
  const frozenRows = Math.min(Math.max(0, input.frozenRows), rows.count);
  const frozenCols = Math.min(Math.max(0, input.frozenCols), cols.count);
  const frozenHeight = Math.min(rows.offsetOf(frozenRows), input.height);
  const frozenWidth = Math.min(cols.offsetOf(frozenCols), input.width);
  const limit = maxScroll(input);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), limit.top);
  const scrollLeft = Math.min(Math.max(0, input.scrollLeft), limit.left);
  const visibleRows = visibleSpan(rows, frozenRows, frozenHeight, scrollTop, input.height);
  const visibleCols = visibleSpan(cols, frozenCols, frozenWidth, scrollLeft, input.width);
  return {
    frozenHeight,
    frozenWidth,
    frozenRows: frozenRows > 0 ? { start: 0, end: frozenRows - 1 } : EMPTY,
    frozenCols: frozenCols > 0 ? { start: 0, end: frozenCols - 1 } : EMPTY,
    rows: widen(visibleRows, overscan, frozenRows, rows.count - 1),
    cols: widen(visibleCols, overscan, frozenCols, cols.count - 1),
    visibleRows,
    visibleCols,
    scrollTop,
    scrollLeft,
  };
}

/** Left edge of a column on screen. */
export function columnX(axes: SheetAxes, viewport: Viewport, col: number): number {
  const offset = axes.cols.offsetOf(col);
  return col <= viewport.frozenCols.end ? offset : offset - viewport.scrollLeft;
}

/** Top edge of a row on screen. */
export function rowY(axes: SheetAxes, viewport: Viewport, row: number): number {
  const offset = axes.rows.offsetOf(row);
  return row <= viewport.frozenRows.end ? offset : offset - viewport.scrollTop;
}

/**
 * Where a range is on screen. A range that crosses a frozen boundary is cut
 * at it, so the result is the part shown in the pane of its top-left cell
 * joined with what continues in the scrolling part; `null` when the range is
 * scrolled completely under the frozen panes.
 */
export function rangeOnScreen(axes: SheetAxes, viewport: Viewport, range: CellRange): PixelRect | null {
  const lastRow = Math.min(range.end.row, axes.rows.count - 1);
  const lastCol = Math.min(range.end.col, axes.cols.count - 1);
  if (lastRow < range.start.row || lastCol < range.start.col) return null;
  let left = columnX(axes, viewport, range.start.col);
  let right = columnX(axes, viewport, lastCol) + axes.cols.sizeOf(lastCol);
  let top = rowY(axes, viewport, range.start.row);
  let bottom = rowY(axes, viewport, lastRow) + axes.rows.sizeOf(lastRow);
  // The scrolling part of a range never shows over the frozen part.
  if (range.start.col > viewport.frozenCols.end) left = Math.max(left, viewport.frozenWidth);
  if (lastCol > viewport.frozenCols.end) right = Math.max(right, viewport.frozenWidth);
  if (range.start.row > viewport.frozenRows.end) top = Math.max(top, viewport.frozenHeight);
  if (lastRow > viewport.frozenRows.end) bottom = Math.max(bottom, viewport.frozenHeight);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The cell under a point of the cell area. Points outside are clamped to the nearest cell. */
export function cellAtPoint(axes: SheetAxes, viewport: Viewport, x: number, y: number): CellAddress {
  const col = x < viewport.frozenWidth ? axes.cols.indexAt(Math.max(0, x)) : axes.cols.indexAt(x + viewport.scrollLeft);
  const row = y < viewport.frozenHeight ? axes.rows.indexAt(Math.max(0, y)) : axes.rows.indexAt(y + viewport.scrollTop);
  return { row, col };
}

/**
 * The scroll offsets that bring a cell fully into view, moving as little as
 * possible. A cell in a frozen row or column needs no scroll in that direction.
 */
export function scrollToReveal(input: ViewportInput, cell: CellAddress): { scrollTop: number; scrollLeft: number } {
  const { rows, cols } = input.axes;
  const viewport = computeViewport(input);
  let { scrollTop, scrollLeft } = viewport;
  const row = Math.min(Math.max(0, cell.row), rows.count - 1);
  const col = Math.min(Math.max(0, cell.col), cols.count - 1);
  if (row > viewport.frozenRows.end) {
    const top = rows.offsetOf(row) - viewport.frozenHeight;
    const bottom = rows.offsetOf(row) + rows.sizeOf(row) - input.height;
    if (top < scrollTop) scrollTop = top;
    else if (bottom > scrollTop) scrollTop = Math.min(top, bottom);
  }
  if (col > viewport.frozenCols.end) {
    const left = cols.offsetOf(col) - viewport.frozenWidth;
    const right = cols.offsetOf(col) + cols.sizeOf(col) - input.width;
    if (left < scrollLeft) scrollLeft = left;
    else if (right > scrollLeft) scrollLeft = Math.min(left, right);
  }
  const limit = maxScroll(input);
  return {
    scrollTop: Math.min(Math.max(0, scrollTop), limit.top),
    scrollLeft: Math.min(Math.max(0, scrollLeft), limit.left),
  };
}

/** Rows that fit in the scrolling part, for Page Up and Page Down. At least 1. */
export function pageRows(viewport: Viewport): number {
  return Math.max(1, spanLength(viewport.visibleRows) - 1);
}

/** Largest native scroll range used; beyond it scroll positions are scaled. Browsers clip elements at a few tens of millions of pixels. */
export const MAX_NATIVE_SCROLL_PX = 8_000_000;

/**
 * Maps the position of a native scrollbar to a sheet offset. For sheets
 * taller than the native range the scrollbar covers the sheet at a coarser
 * step; smaller sheets map one to one.
 */
export interface ScrollScale {
  /** The largest native scroll position. */
  nativeMax: number;
  toSheet(native: number): number;
  toNative(sheet: number): number;
}

export function createScrollScale(sheetMax: number, nativeLimit: number = MAX_NATIVE_SCROLL_PX): ScrollScale {
  if (sheetMax <= nativeLimit) {
    return { nativeMax: Math.max(0, sheetMax), toSheet: (native) => native, toNative: (sheet) => sheet };
  }
  const ratio = sheetMax / nativeLimit;
  return {
    nativeMax: nativeLimit,
    toSheet: (native) => Math.min(sheetMax, Math.max(0, Math.round(native * ratio))),
    toNative: (sheet) => Math.min(nativeLimit, Math.max(0, sheet / ratio)),
  };
}
