/** Column widths and merged ranges. */

import type { CellRange } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { guardArrayWrite } from "./arrays.js";
import { forEachCellIn, writeCell } from "./cells.js";
import type { ColumnRun, SheetModel, WorkbookState } from "./model.js";
import { holdsTableHeader } from "./tables.js";

/** Sets or clears the width of one column, splitting the run of columns it belongs to. */
export function setColumnWidth(sheet: SheetModel, col: number, width: number | null): void {
  const runs: ColumnRun[] = [];
  let found = false;
  for (const run of sheet.columns) {
    if (col < run.min || col > run.max) {
      runs.push(run);
      continue;
    }
    found = true;
    if (run.min < col) runs.push({ ...run, max: col - 1 });
    // Without a width the column keeps a record only when it carries something else.
    if (width !== null || run.hidden || run.other.length > 0) runs.push({ ...run, min: col, max: col, width });
    if (run.max > col) runs.push({ ...run, min: col + 1 });
  }
  if (!found) {
    if (width === null) return;
    runs.push({ min: col, max: col, width, hidden: false, other: [] });
  }
  sheet.columns = runs.sort((a, b) => a.min - b.min);
  sheet.columnsDirty = true;
  sheet.dirty = true;
}

function intersects(a: CellRange, b: CellRange): boolean {
  return a.start.row <= b.end.row && b.start.row <= a.end.row && a.start.col <= b.end.col && b.start.col <= a.end.col;
}

/**
 * Merges a range. Cells other than the top-left one lose their content, as a
 * merge shows only that cell. Those cells go through the checks of any
 * content edit before one is touched: a merge that would clear part of an
 * array formula (or any of it inside a proposal) or a table header throws
 * `invalid_operation` and changes nothing.
 */
export function setMerge(state: WorkbookState, sheet: SheetModel, range: CellRange): void {
  if (range.start.row === range.end.row && range.start.col === range.end.col) return;
  if (sheet.merges.some((merge) => intersects(merge, range))) {
    throw new OfficeError("invalid_operation", "the range overlaps a merged range");
  }
  const isTopLeft = (row: number, col: number): boolean => row === range.start.row && col === range.start.col;
  const cleared: Array<{ row: number; col: number; styleId: number }> = [];
  forEachCellIn(sheet, range, (cell, row, col) => {
    if (isTopLeft(row, col) || (cell.value === null && cell.formula === null)) return;
    cleared.push({ row, col, styleId: cell.styleId });
  });
  if (cleared.length > 0) {
    guardArrayWrite(state, sheet, range, (row, col) => !isTopLeft(row, col));
    if (sheet.tables.length > 0 && holdsTableHeader(sheet, range)) {
      for (const { row, col } of cleared) {
        if (holdsTableHeader(sheet, { start: { row, col }, end: { row, col } })) {
          throw new OfficeError("invalid_operation", "the header of a table cannot be cleared by a merge");
        }
      }
    }
  }
  for (const { row, col, styleId } of cleared) writeCell(state, sheet, row, col, { value: null, formula: null, styleId }, "edit");
  sheet.merges.push({ start: { ...range.start }, end: { ...range.end } });
  sheet.mergesDirty = true;
  sheet.dirty = true;
}

/** Removes every merge that intersects the range. */
export function unmerge(sheet: SheetModel, range: CellRange): void {
  const kept = sheet.merges.filter((merge) => !intersects(merge, range));
  if (kept.length === sheet.merges.length) return;
  sheet.merges = kept;
  sheet.mergesDirty = true;
  sheet.dirty = true;
}
