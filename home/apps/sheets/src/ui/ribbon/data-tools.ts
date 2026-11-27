/**
 * Data commands built from the session's ordinary edits: removing duplicate
 * rows of values and splitting a column of text into columns. Each is one
 * undo step and refuses, with a reason, what it cannot do safely.
 */
import type { SheetGridController } from "../../grid";
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
  const rows: string[][] = [];
  let split = 0;
  for (let row = start.row; row <= end.row; row++) {
    const raw = session.raw(sheet, row, start.col);
    const parts = raw.formula === null && typeof raw.value === "string" ? raw.value.split(delimiter.text) : [];
    if (parts.length < 2) {
      rows.push([]);
      continue;
    }
    // Checked before the cells to the right are read: past the last column there are none.
    if (start.col + parts.length > MAX_COLS) return { ok: false, message: "The split would go past the last column of the sheet. Move the text further left, then split." };
    for (let offset = 1; offset < parts.length; offset++) {
      if (!session.isBlank(sheet, row, start.col + offset)) return { ok: false, message: "The cells to the right are not empty. Insert columns first, then split." };
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
