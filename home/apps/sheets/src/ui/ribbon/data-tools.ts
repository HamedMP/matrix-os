/**
 * Data commands built from the session's ordinary edits: removing duplicate
 * rows of values and splitting a column of text into columns. Each is one
 * undo step and refuses, with a reason, what it cannot do safely.
 */
import type { SheetGridController } from "../../grid";
import { MAX_ACTION_CELLS } from "../../grid/actions-data";
import { MERGED_CELLS, coveredIn, crossesMerge } from "../../grid/merge-guard";
import { type CellValue, MAX_COLS } from "../../session/engine";

export type DataResult = { ok: true; message: string } | { ok: false; message: string };

/** Most cells either command reads in one go. */
export const MAX_DATA_CELLS = 200_000;

export const SPLIT_DELIMITERS = [
  { id: "comma", label: "Comma", text: "," },
  { id: "semicolon", label: "Semicolon", text: ";" },
  { id: "tab", label: "Tab", text: "\t" },
  { id: "space", label: "Space", text: " " },
] as const;

export type SplitDelimiterId = (typeof SPLIT_DELIMITERS)[number]["id"];

function tooLarge(rows: number, cols: number): boolean {
  return rows * cols > MAX_DATA_CELLS;
}

/**
 * Keeps the first of each set of identical rows in the selected range and
 * moves the rest up, clearing the rows left over. Cell formats stay where
 * they are. A range with formulas is refused: moving a formula would change
 * what it refers to.
 */
export function removeDuplicateRows(controller: SheetGridController): DataResult {
  const session = controller.session;
  const sheet = controller.getSelection().sheet;
  const { start, end } = controller.getActiveRange();
  const width = end.col - start.col + 1;
  const height = end.row - start.row + 1;
  if (height < 2) return { ok: false, message: "Select at least two rows to look for duplicates." };
  if (tooLarge(height, width)) return { ok: false, message: "The selection is too large. Select fewer rows or columns." };
  // Rows move up but merges stay put: a moved value would land under a merged cell.
  if (crossesMerge(session.workbook.getSheet(sheet).mergedRanges, { start, end })) return { ok: false, message: MERGED_CELLS };
  const kept: CellValue[][] = [];
  const seen = new Set<string>();
  for (let row = start.row; row <= end.row; row++) {
    const values: CellValue[] = [];
    for (let col = start.col; col <= end.col; col++) {
      const raw = session.raw(sheet, row, col);
      if (raw.formula !== null) return { ok: false, message: "The selection holds formulas. Remove duplicates works on values only." };
      values.push(raw.value);
    }
    const key = JSON.stringify(values);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(values);
  }
  const removed = height - kept.length;
  if (removed === 0) return { ok: true, message: "No duplicate rows found." };
  const result = session.transact("Remove duplicates", (tx) => {
    tx.reserve(height * width);
    tx.workbook.setRange(sheet, start, kept);
    tx.workbook.clearRange(sheet, { start: { row: start.row + kept.length, col: start.col }, end }, "contents");
  });
  if (!result.ok) return result;
  // Records moved up: the filter hides again the rows that now hold what it rejects.
  controller.refreshFilter();
  return { ok: true, message: `Removed ${removed} duplicate ${removed === 1 ? "row" : "rows"}. ${kept.length} unique ${kept.length === 1 ? "row remains" : "rows remain"}.` };
}

/** The parts of `text` between delimiters, stopping once there are more than `most`: the caller refuses those. */
function splitAtMost(text: string, delimiter: string, most: number): string[] {
  const parts: string[] = [];
  let from = 0;
  while (parts.length <= most) {
    const at = text.indexOf(delimiter, from);
    if (at < 0) {
      parts.push(text.slice(from));
      break;
    }
    parts.push(text.slice(from, at));
    from = at + delimiter.length;
  }
  return parts;
}

/**
 * Splits the text of the selected column at a delimiter into the columns to
 * its right. Refused when those cells are not empty, so nothing is written
 * over, or when the parts would not fit before the last column. Formulas and numbers stay as they are.
 */
export function splitTextToColumns(controller: SheetGridController, delimiterId: SplitDelimiterId): DataResult {
  const session = controller.session;
  const sheet = controller.getSelection().sheet;
  const { start, end } = controller.getActiveRange();
  const delimiter = SPLIT_DELIMITERS.find((entry) => entry.id === delimiterId);
  if (delimiter === undefined) return { ok: false, message: "Choose a delimiter." };
  if (start.col !== end.col) return { ok: false, message: "Select one column to split." };
  if (tooLarge(end.row - start.row + 1, 1)) return { ok: false, message: "The selection is too large. Select fewer rows." };
  // A part written under a merged cell would be stored but never shown.
  const covered = coveredIn(session.workbook.getSheet(sheet).mergedRanges, { start, end: { row: end.row, col: MAX_COLS - 1 } });
  const rows: string[][] = [];
  const fit = MAX_COLS - start.col;
  let split = 0;
  let cells = 0;
  for (let row = start.row; row <= end.row; row++) {
    const raw = session.raw(sheet, row, start.col);
    // Splitting stops once the parts pass the last column or the cells one step can write: those are refused.
    const most = Math.min(fit, MAX_ACTION_CELLS - cells);
    const parts = raw.formula === null && typeof raw.value === "string" ? splitAtMost(raw.value, delimiter.text, most) : [];
    if (parts.length < 2) {
      rows.push([]);
      continue;
    }
    // Checked before the cells to the right are read: past the last column there are none.
    if (parts.length > fit) return { ok: false, message: "The split would go past the last column of the sheet. Move the text further left, then split." };
    if (parts.length > most) return { ok: false, message: "The split would make too many cells for one step. Select fewer rows." };
    cells += parts.length;
    for (let offset = 1; offset < parts.length; offset++) {
      if (!session.isBlank(sheet, row, start.col + offset)) return { ok: false, message: "The cells to the right are not empty. Insert columns first, then split." };
      if (covered(row, start.col + offset)) return { ok: false, message: MERGED_CELLS };
    }
    // Text that looks like a formula stays text; numbers and dates are read as typed.
    rows.push(parts.map((part) => (part.trim().startsWith("=") ? `'${part.trim()}` : part.trim())));
    split++;
  }
  if (split === 0) return { ok: false, message: `No cell in the selection contains a ${delimiter.label.toLowerCase()} to split at.` };
  const result = session.setInputs(sheet, { row: start.row, col: start.col }, rows, "Text to columns");
  if (!result.ok) return result;
  return { ok: true, message: `Split ${split} ${split === 1 ? "cell" : "cells"} into columns.` };
}
