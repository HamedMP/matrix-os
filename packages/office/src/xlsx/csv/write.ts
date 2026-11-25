/** Writing one sheet as delimiter-separated text. */

import type { Cell, CellRange, CellValue, ToCsv } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { isDateFormat } from "../format/index.js";
import { serialToIso } from "../format/serial.js";
import { requireRange } from "../workbook/a1.js";
import { findCell } from "../workbook/cells.js";
import type { SheetModel, WorkbookState } from "../workbook/model.js";
import { findState } from "../workbook/workbook.js";
import { isCsvWorkbook, sourceTextOf } from "./source.js";

/** Cells one export may cover. */
const MAX_EXPORT_CELLS = 20_000_000;

/** A value as raw mode writes it: numbers unformatted. */
export function rawText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  return value.code;
}

/**
 * The raw text of a cell of a workbook that was read from a CSV file. Such a
 * file has no number formats, so the text is all there is: a field nobody
 * edited is written as it came, and a date is written as a date
 * (`yyyy-mm-dd`, with ` hh:mm:ss` when it has a time), which reads back as
 * the same date. A time without a day is written as it is shown.
 */
function csvFieldText(state: WorkbookState, sheet: SheetModel, row: number, col: number, cell: Cell): string {
  const record = findCell(sheet, row, col);
  const source = record === undefined ? null : sourceTextOf(record);
  if (source !== null) return source;
  const value = cell.value;
  if (typeof value !== "number" || !isDateFormat(state.styles.numberFormat(cell.styleId))) return rawText(value);
  if (value < 1) return cell.display;
  const iso = serialToIso(value, state.date1904);
  return iso === null ? rawText(value) : iso.replace("T", " ");
}

export const toCsv: ToCsv = (workbook, sheet, options) => {
  const delimiter = options?.delimiter ?? ",";
  if (typeof delimiter !== "string" || delimiter.length !== 1 || delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
    throw new OfficeError("invalid_argument", "the delimiter is one character other than a quote or a line break");
  }
  const lineEnding = options?.lineEnding ?? "\r\n";
  if (lineEnding !== "\r\n" && lineEnding !== "\n") throw new OfficeError("invalid_argument", "unknown line ending");
  const mode = options?.values ?? "raw";
  if (mode !== "raw" && mode !== "display") throw new OfficeError("invalid_argument", "values are raw or display");
  const info = workbook.getSheet(sheet);
  const state = findState(workbook);
  const model = state !== null && isCsvWorkbook(state) ? (state.sheetsById.get(sheet) ?? null) : null;
  const range: CellRange | null = options?.range === undefined ? info.dimensions : requireRange(options.range);
  if (range === null) return "";
  const width = range.end.col - range.start.col + 1;
  if ((range.end.row - range.start.row + 1) * width > MAX_EXPORT_CELLS) {
    throw new OfficeError("limit_exceeded", "the range is too large to export");
  }
  const needsQuotes = new RegExp(`[${delimiter === "\\" || delimiter === "]" || delimiter === "^" || delimiter === "-" ? `\\${delimiter}` : delimiter}"\\r\\n]`);
  const lines: string[] = [];
  for (let row = range.start.row; row <= range.end.row; row++) {
    const cells = workbook.getRange(sheet, { start: { row, col: range.start.col }, end: { row, col: range.end.col } })[0] ?? [];
    const fields: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as Cell;
      const text =
        mode === "display"
          ? cell.display
          : state !== null && model !== null
            ? csvFieldText(state, model, row, range.start.col + i, cell)
            : rawText(cell.value);
      fields.push(needsQuotes.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join(lineEnding);
};
