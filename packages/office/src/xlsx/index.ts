/**
 * Workbooks: opening, reading, editing and saving `.xlsx` files, CSV import
 * and export, number format rendering and A1 addressing.
 * Implements the contract in `../api/xlsx.ts`.
 */

import type { CreateXlsx, OpenXlsx, XlsxModule } from "../api/xlsx.js";
import { OfficeError } from "../errors.js";
import { makeParseCsv, toCsv } from "./csv/index.js";
import { formatValue } from "./format/index.js";
import * as formula from "./formula/index.js";
import {
  MAX_COLS,
  MAX_ROWS,
  columnIndex,
  columnLabel,
  formatA1,
  formatA1Range,
  parseA1,
  parseA1Range,
  parseSheetRange,
} from "./workbook/a1.js";
import { type WorkbookDeps, createState, openState } from "./workbook/open.js";
import { checkSheetNameText } from "./workbook/sheets.js";
import { createHandle } from "./workbook/workbook.js";

export type * from "../api/xlsx.js";
export { formatValueDetailed, isDateFormat, isoToSerial, partsToSerial, serialToIso, serialToParts } from "./format/index.js";
export type { DateParts, FormattedValue } from "./format/index.js";
export { quoteSheetName } from "./workbook/a1.js";

const deps: WorkbookDeps = { formula };

export const openXlsx: OpenXlsx = async (bytes, options) => createHandle(await openState(bytes, options, deps));

/** Sheets a new workbook may be created with. */
const MAX_NEW_SHEETS = 255;

export const createXlsx: CreateXlsx = (options) => {
  const names: unknown = options?.sheetNames ?? ["Sheet1"];
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_NEW_SHEETS) {
    throw new OfficeError("invalid_argument", "a workbook needs 1 to 255 sheet names");
  }
  const checked: string[] = [];
  for (const name of names as unknown[]) {
    checkSheetNameText(name);
    if (checked.some((other) => other.toLowerCase() === name.toLowerCase())) {
      throw new OfficeError("invalid_argument", "sheet names must be unique");
    }
    checked.push(name);
  }
  return createHandle(createState(checked, deps));
};

export const parseCsv = makeParseCsv(createXlsx);

export {
  MAX_COLS,
  MAX_ROWS,
  columnIndex,
  columnLabel,
  formatA1,
  formatA1Range,
  formatValue,
  parseA1,
  parseA1Range,
  parseSheetRange,
  toCsv,
};

/** Every contract export as one object; also the compile-time proof that the module is complete. */
export const xlsxModule: XlsxModule = Object.freeze({
  openXlsx,
  createXlsx,
  parseCsv,
  toCsv,
  formatValue,
  columnLabel,
  columnIndex,
  parseA1,
  formatA1,
  parseA1Range,
  formatA1Range,
  parseSheetRange,
  MAX_ROWS,
  MAX_COLS,
});
