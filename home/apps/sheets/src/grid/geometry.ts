/**
 * Sizes and positions of rows and columns, in CSS pixels.
 *
 * An {@link Axis} answers "where does row 71 234 start" and "which row is at
 * pixel 1 400 000" in logarithmic time for any sheet size: it stores only the
 * rows or columns whose size differs from the default.
 */

import type { CellRange, SheetInfo } from "../session/engine";
import { MAX_COLS, MAX_ROWS } from "../session/engine";

export const HEADER_HEIGHT_PX = 24;
export const ROW_HEADER_WIDTH_PX = 56;
export const MIN_COLUMN_PX = 12;
export const MIN_ROW_PX = 8;

/** Spreadsheet column width (characters of the default font) to pixels. */
export function columnWidthToPx(chars: number): number {
  return Math.max(0, Math.round(chars * 7 + 5));
}

export function pxToColumnWidth(px: number): number {
  return Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
}

/** Row height in points to pixels. */
export function rowHeightToPx(points: number): number {
  return Math.max(0, Math.round((points * 4) / 3));
}

export function pxToRowHeight(px: number): number {
  return Math.max(0, Math.round(px * 0.75 * 100) / 100);
}

export interface Axis {
  /** Number of rows or columns. */
  readonly count: number;
  readonly defaultSize: number;
  /** Size of everything, in pixels. */
  readonly total: number;
  /** Where an index starts. `offsetOf(count)` is `total`. */
  offsetOf(index: number): number;
  sizeOf(index: number): number;
  /** The index that holds a pixel offset, clamped to the axis. A hidden (zero-size) index is never returned. */
  indexAt(offset: number): number;
}

/**
 * Builds an axis. `overrides` gives the size of each index that differs from
 * the default; 0 hides it. Entries past `count` are ignored.
 */
export function createAxis(count: number, defaultSize: number, overrides: Iterable<readonly [number, number]> = []): Axis {
  const entries: Array<readonly [number, number]> = [];
  for (const entry of overrides) {
    if (entry[0] >= 0 && entry[0] < count && entry[1] !== defaultSize) entries.push(entry);
  }
  entries.sort((a, b) => a[0] - b[0]);
  const indexes: number[] = [];
  const sizes: number[] = [];
  /** `starts[k]` is the pixel offset where override `k` begins. */
  const starts: number[] = [];
  let delta = 0;
  for (const [index, size] of entries) {
    if (indexes.length > 0 && indexes[indexes.length - 1] === index) {
      // The last entry for an index wins.
      delta -= (sizes[sizes.length - 1] as number) - defaultSize;
      indexes.pop();
      sizes.pop();
      starts.pop();
    }
    starts.push(index * defaultSize + delta);
    indexes.push(index);
    sizes.push(size);
    delta += size - defaultSize;
  }
  const total = Math.max(0, count * defaultSize + delta);

  /** Number of overrides with an index below `index`. */
  function before(index: number): number {
    let low = 0;
    let high = indexes.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((indexes[mid] as number) < index) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function offsetOf(index: number): number {
    if (index <= 0) return 0;
    if (index >= count) return total;
    const k = before(index);
    if (k === 0) return index * defaultSize;
    const last = k - 1;
    return (starts[last] as number) + (sizes[last] as number) + (index - (indexes[last] as number) - 1) * defaultSize;
  }

  function sizeOf(index: number): number {
    const k = before(index);
    return indexes[k] === index ? (sizes[k] as number) : defaultSize;
  }

  function indexAt(offset: number): number {
    if (count <= 0) return 0;
    if (offset <= 0) return firstVisible(0);
    if (offset >= total) return lastVisible(count - 1);
    // The last override that starts at or before the offset.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((starts[mid] as number) <= offset) low = mid + 1;
      else high = mid;
    }
    const k = low - 1;
    if (k < 0) return Math.min(count - 1, Math.floor(offset / defaultSize));
    const start = starts[k] as number;
    const size = sizes[k] as number;
    const index = indexes[k] as number;
    if (offset < start + size) return index;
    if (defaultSize <= 0) return firstVisible(index + 1);
    return Math.min(count - 1, index + 1 + Math.floor((offset - start - size) / defaultSize));
  }

  function firstVisible(from: number): number {
    let index = from;
    while (index < count - 1 && sizeOf(index) === 0) index++;
    return index;
  }

  function lastVisible(from: number): number {
    let index = from;
    while (index > 0 && sizeOf(index) === 0) index--;
    return index;
  }

  return { count, defaultSize, total, offsetOf, sizeOf, indexAt };
}

export interface GridExtent {
  rows: number;
  cols: number;
}

const MIN_ROWS = 200;
const MIN_COLS = 26;
const ROW_MARGIN = 100;
const COL_MARGIN = 13;

/**
 * How many rows and columns the grid shows: the used area and every cell of
 * interest (the active cell, the ends of the selection), plus room to keep
 * going, up to the limits of a sheet.
 */
export function gridExtent(used: CellRange | null, focus: ReadonlyArray<{ row: number; col: number }> = []): GridExtent {
  let lastRow = used?.end.row ?? 0;
  let lastCol = used?.end.col ?? 0;
  for (const cell of focus) {
    if (cell.row > lastRow) lastRow = cell.row;
    if (cell.col > lastCol) lastCol = cell.col;
  }
  return {
    rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, lastRow + 1 + ROW_MARGIN)),
    cols: Math.min(MAX_COLS, Math.max(MIN_COLS, lastCol + 1 + COL_MARGIN)),
  };
}

export interface SheetAxes {
  rows: Axis;
  cols: Axis;
}

/**
 * The axes of a sheet. `hiddenRows` are rows a filter hides in this view;
 * rows and columns the file marks hidden have no size either. `override`
 * is the size of a row or column while its header edge is being dragged.
 */
export function sheetAxes(
  info: SheetInfo,
  extent: GridExtent,
  hiddenRows: ReadonlySet<number> | null = null,
  override: { axis: "row" | "col"; index: number; size: number } | null = null,
): SheetAxes {
  const rowDefault = Math.max(MIN_ROW_PX, rowHeightToPx(info.defaultRowHeightPt));
  const colDefault = Math.max(MIN_COLUMN_PX, columnWidthToPx(info.defaultColumnWidth));
  // A later entry for an index replaces an earlier one, so the order below is the order of precedence.
  const rowSizes = new Map<number, number>();
  for (const row of info.rows) rowSizes.set(row.index, row.hidden ? 0 : Math.max(MIN_ROW_PX, rowHeightToPx(row.heightPt)));
  if (override !== null && override.axis === "row") rowSizes.set(override.index, override.size);
  if (hiddenRows !== null) for (const row of hiddenRows) rowSizes.set(row, 0);
  const colSizes = new Map<number, number>();
  for (const col of info.columns) colSizes.set(col.index, col.hidden ? 0 : Math.max(MIN_COLUMN_PX, columnWidthToPx(col.width)));
  if (override !== null && override.axis === "col") colSizes.set(override.index, override.size);
  return {
    rows: createAxis(extent.rows, rowDefault, rowSizes),
    cols: createAxis(extent.cols, colDefault, colSizes),
  };
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle of a range in sheet pixels (before scrolling). The range is clamped to the axes. */
export function rangeRect(axes: SheetAxes, range: CellRange): PixelRect {
  const lastRow = Math.min(range.end.row, axes.rows.count - 1);
  const lastCol = Math.min(range.end.col, axes.cols.count - 1);
  const x = axes.cols.offsetOf(range.start.col);
  const y = axes.rows.offsetOf(range.start.row);
  return {
    x,
    y,
    width: Math.max(0, axes.cols.offsetOf(lastCol + 1) - x),
    height: Math.max(0, axes.rows.offsetOf(lastRow + 1) - y),
  };
}
