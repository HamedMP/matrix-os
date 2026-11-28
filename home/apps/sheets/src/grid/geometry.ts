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

/**
 * Pixels per character of a column width. A file gives a column's width in
 * digits of its default font: 7 px each in Excel's Calibri 11. The grid draws
 * in a 13 px font whose digits are 8 px wide, so a width counts 8 px per
 * character here and holds the same numbers and dates as in Excel, instead of
 * showing `####` for a value that fits there.
 */
export const COLUMN_CHAR_PX = 8;
/** Pixels a column has beyond its characters: the padding on both sides and the grid line. */
const COLUMN_EXTRA_PX = 5;

/** Spreadsheet column width (characters of the default font) to pixels. */
export function columnWidthToPx(chars: number): number {
  return Math.max(0, Math.round(chars * COLUMN_CHAR_PX + COLUMN_EXTRA_PX));
}

export function pxToColumnWidth(px: number): number {
  return Math.max(0, Math.round(((px - COLUMN_EXTRA_PX) / COLUMN_CHAR_PX) * 100) / 100);
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
  /** The first index at or after `from` that is not hidden, or `count` when there is none. Skips a run of hidden indexes at once. */
  nextVisible(from: number): number;
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
  // For a hidden override, the override that ends its run of consecutive hidden indexes (runLast) and the one that starts it (runFirst).
  const runLast: number[] = new Array<number>(indexes.length);
  const runFirst: number[] = new Array<number>(indexes.length);
  for (let k = indexes.length - 1; k >= 0; k--) {
    const joined = k + 1 < indexes.length && sizes[k + 1] === 0 && indexes[k + 1] === (indexes[k] as number) + 1;
    runLast[k] = joined ? (runLast[k + 1] as number) : k;
  }
  for (let k = 0; k < indexes.length; k++) {
    const joined = k > 0 && sizes[k - 1] === 0 && indexes[k - 1] === (indexes[k] as number) - 1;
    runFirst[k] = joined ? (runFirst[k - 1] as number) : k;
  }

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

  function nextVisible(from: number): number {
    let index = Math.max(0, from);
    while (index < count) {
      const k = before(index);
      if (indexes[k] === index) {
        if ((sizes[k] as number) > 0) return index;
        index = (indexes[runLast[k] as number] as number) + 1;
      } else if (defaultSize > 0) {
        return index;
      } else {
        // Every index without an override is hidden: the next override that has a size.
        let next = k;
        while (next < indexes.length && (sizes[next] as number) <= 0) next = (runLast[next] as number) + 1;
        return next < indexes.length ? Math.min(count, indexes[next] as number) : count;
      }
    }
    return count;
  }

  function previousVisible(from: number): number {
    let index = Math.min(count - 1, from);
    while (index >= 0) {
      const k = before(index);
      if (indexes[k] === index) {
        if ((sizes[k] as number) > 0) return index;
        index = (indexes[runFirst[k] as number] as number) - 1;
      } else if (defaultSize > 0) {
        return index;
      } else {
        let next = k - 1;
        while (next >= 0 && (sizes[next] as number) <= 0) next = (runFirst[next] as number) - 1;
        return next >= 0 ? (indexes[next] as number) : -1;
      }
    }
    return -1;
  }

  function firstVisible(from: number): number {
    const index = nextVisible(from);
    return index < count ? index : Math.max(0, count - 1);
  }

  function lastVisible(from: number): number {
    return Math.max(0, previousVisible(from));
  }

  return { count, defaultSize, total, offsetOf, sizeOf, indexAt, nextVisible };
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
