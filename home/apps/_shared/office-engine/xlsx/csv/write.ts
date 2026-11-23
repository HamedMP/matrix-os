/** Writing one sheet as delimiter-separated text. */

import type { CellRange, CellValue, ToCsv } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { requireRange } from "../workbook/a1.js";

/** Cells one export may cover. */
const MAX_EXPORT_CELLS = 20_000_000;

function rawText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  return value.code;
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
    for (const cell of cells) {
      const text = mode === "display" ? cell.display : rawText(cell.value);
      fields.push(needsQuotes.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(fields.join(delimiter));
  }
  return lines.join(lineEnding);
};
