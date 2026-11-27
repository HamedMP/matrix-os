/** CSV import and export for workbooks. */

import type { CreateXlsx, ParseCsv } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import type { SheetModel } from "../workbook/model.js";
import { findCell, writeCell } from "../workbook/cells.js";
import { MAX_CELL_TEXT } from "../workbook/state.js";
import { applyStylePatch } from "../workbook/style-write.js";
import { stateOf } from "../workbook/workbook.js";
import { inferField } from "./infer.js";
import { scanCsv, sniffDelimiter, stripBom } from "./parse.js";
import { markCsvWorkbook, noteSourceText } from "./source.js";
import { rawText } from "./write.js";

export { inferField } from "./infer.js";
export { scanCsv, sniffDelimiter } from "./parse.js";
export { toCsv } from "./write.js";

const DEFAULT_MAX_CELLS = 2_000_000;

/**
 * Builds `parseCsv` on top of a workbook factory. The factory is passed in
 * because the workbook module is what wires in the formula engine.
 */
export function makeParseCsv(createXlsx: CreateXlsx): ParseCsv {
  return (text, options) => {
    if (typeof text !== "string") throw new OfficeError("invalid_argument", "CSV input must be text");
    const body = stripBom(text);
    const delimiter = options?.delimiter ?? sniffDelimiter(body);
    if (typeof delimiter !== "string" || delimiter.length !== 1 || delimiter === '"' || delimiter === "\r" || delimiter === "\n") {
      throw new OfficeError("invalid_argument", "the delimiter is one character other than a quote or a line break");
    }
    const maxCells = options?.maxCells;
    const limit = typeof maxCells === "number" && Number.isInteger(maxCells) && maxCells >= 0 ? maxCells : DEFAULT_MAX_CELLS;
    const records = scanCsv(body, { delimiter, maxCells: limit });
    const workbook = createXlsx({ sheetNames: [options?.sheetName ?? "Sheet1"] });
    const state = stateOf(workbook);
    state.maxCells = Math.max(state.maxCells, limit);
    const sheet = state.sheets[0] as SheetModel;
    const infer = options?.inferTypes !== false;
    // Style id per number format. Two entries at most.
    const formats = new Map<string, number>();
    for (let r = 0; r < records.length; r++) {
      const record = records[r] as (typeof records)[number];
      for (let c = 0; c < record.length; c++) {
        const field = record[c] as (typeof record)[number];
        if (field.text === "") continue;
        let styleId = 0;
        let value: string | number | boolean | null = field.text;
        if (infer) {
          const inferred = inferField(field.text, false);
          value = inferred.value as string | number | boolean | null;
          if (inferred.format !== null) {
            let id = formats.get(inferred.format);
            if (id === undefined) {
              id = applyStylePatch(state.styles, 0, { numberFormat: inferred.format });
              formats.set(inferred.format, id);
            }
            styleId = id;
          }
        }
        // A cell holds at most 32767 characters; longer text is cut, as a spreadsheet does on import.
        if (typeof value === "string" && value.length > MAX_CELL_TEXT) value = value.slice(0, MAX_CELL_TEXT);
        writeCell(state, sheet, r, c, { value, formula: null, styleId }, null);
        // A field that would be written differently from how it came (`10.00`, a date) keeps its text.
        if (typeof value !== "string" && (styleId !== 0 || rawText(value) !== field.text)) {
          const cell = findCell(sheet, r, c);
          if (cell !== undefined) noteSourceText(cell, field.text);
        }
      }
    }
    // Nothing was calculated and nothing needs to be: the sheet holds literals only.
    state.calc.edited.clear();
    markCsvWorkbook(state);
    return workbook;
  };
}
