/**
 * What a CSV file said, for the cells that still hold it.
 *
 * `parseCsv` turns `10.00` into the number 10 and `2026-03-14` into a date.
 * Writing the sheet back must not rewrite fields nobody touched, so the text
 * of every field whose typed value would be written differently is kept
 * with its cell. The entries hang off the cell records: they move with rows
 * and columns and go when the cell does.
 */

import type { CellValue } from "../../api/xlsx.js";
import type { CellRec, WorkbookState } from "../workbook/model.js";
import { sameValue } from "../workbook/state.js";

interface SourceField {
  text: string;
  /** The value the text was read as; the text stands for the cell only while it holds this value. */
  value: CellValue;
}

const sources = new WeakMap<CellRec, SourceField>();
/** Workbooks made by `parseCsv`. */
const csvBooks = new WeakSet<WorkbookState>();

export function markCsvWorkbook(state: WorkbookState): void {
  csvBooks.add(state);
}

export function isCsvWorkbook(state: WorkbookState): boolean {
  return csvBooks.has(state);
}

export function noteSourceText(cell: CellRec, text: string): void {
  sources.set(cell, { text, value: cell.value });
}

/** The field a cell was read from, or null when the cell was edited since or never came from a file. */
export function sourceTextOf(cell: CellRec): string | null {
  if (cell.formula !== null) return null;
  const source = sources.get(cell);
  return source !== undefined && sameValue(source.value, cell.value) ? source.text : null;
}
