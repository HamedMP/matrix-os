/**
 * Rows or columns of a sheet as a band: reading their content before a
 * proposed deletion, checking that inserted ones are still empty, and
 * comparing merged-range lists.
 */

import type { CellRange, SheetInfo } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import type { JournalContext } from "./context.js";
import { holds } from "./record.js";
import { type BandSnapshot, MAX_SNAPSHOT_CELLS } from "./types.js";

export type Axis = "row" | "col";

/** The part of the band inside the sheet's used area, or null when they do not meet. */
function bandArea(info: SheetInfo, axis: Axis, index: number, count: number): CellRange | null {
  const used = info.dimensions;
  if (used === null) return null;
  const low = axis === "row" ? used.start.row : used.start.col;
  const high = axis === "row" ? used.end.row : used.end.col;
  const first = Math.max(index, low);
  const last = Math.min(index + count - 1, high);
  if (first > last) return null;
  return axis === "row"
    ? { start: { row: first, col: used.start.col }, end: { row: last, col: used.end.col } }
    : { start: { row: used.start.row, col: first }, end: { row: used.end.row, col: last } };
}

function areaSize(area: CellRange): number {
  return (area.end.row - area.start.row + 1) * (area.end.col - area.start.col + 1);
}

/** Content of the band before it is deleted. Throws `limit_exceeded` above {@link MAX_SNAPSHOT_CELLS}. */
export function captureBand(ctx: JournalContext, info: SheetInfo, axis: Axis, index: number, count: number): BandSnapshot {
  const cells: BandSnapshot["cells"] = [];
  const area = bandArea(info, axis, index, count);
  if (area !== null) {
    if (areaSize(area) > MAX_SNAPSHOT_CELLS) {
      throw new OfficeError("limit_exceeded", "too many cells to delete in a proposal", {
        details: { maxSnapshotCells: MAX_SNAPSHOT_CELLS },
      });
    }
    for (let row = area.start.row; row <= area.end.row; row++) {
      for (let col = area.start.col; col <= area.end.col; col++) {
        const raw = ctx.internals.readRawCell(info.id, { row, col });
        if (raw.value !== null || raw.formula !== null || raw.styleId !== 0) cells.push({ row, col, raw });
      }
    }
  }
  const sizes: BandSnapshot["sizes"] = [];
  const end = index + count;
  if (axis === "row") {
    for (const row of info.rows) {
      if (row.index >= index && row.index < end && row.heightPt !== info.defaultRowHeightPt) sizes.push({ index: row.index, size: row.heightPt });
    }
  } else {
    for (const column of info.columns) {
      if (column.index >= index && column.index < end && column.width !== info.defaultColumnWidth) sizes.push({ index: column.index, size: column.width });
    }
  }
  return { cells, sizes };
}

/**
 * True when no cell of the band holds a value, a formula or a style, once
 * the pending cell changes recorded after `afterSeq` are taken back: those
 * were made on top of the inserted band, and rejecting them empties their
 * cells again. A cell that no longer holds such a change's new content counts
 * with what it holds. Bounded like {@link captureBand}.
 */
export function bandIsEmpty(ctx: JournalContext, info: SheetInfo, axis: Axis, index: number, count: number, afterSeq: number): boolean {
  const area = bandArea(info, axis, index, count);
  if (area === null) return true;
  if (areaSize(area) > MAX_SNAPSHOT_CELLS) return false;
  for (let row = area.start.row; row <= area.end.row; row++) {
    for (let col = area.start.col; col <= area.end.col; col++) {
      const current = ctx.internals.readRawCell(info.id, { row, col });
      const later = ctx.store.cellAt(info.id, row, col);
      const raw = later !== undefined && later.seq > afterSeq && holds(current, later.next) ? later.old : current;
      if (raw.value !== null || raw.formula !== null || raw.styleId !== 0) return false;
    }
  }
  return true;
}

function rangeKey(range: CellRange): string {
  return `${range.start.row}:${range.start.col}:${range.end.row}:${range.end.col}`;
}

export function sameRanges(a: readonly CellRange[], b: readonly CellRange[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(rangeKey));
  return b.every((range) => keys.has(rangeKey(range)));
}

/** Ranges of `a` that are not in `b`. */
export function rangesMissing(a: readonly CellRange[], b: readonly CellRange[]): CellRange[] {
  const keys = new Set(b.map(rangeKey));
  return a.filter((range) => !keys.has(rangeKey(range)));
}
