/**
 * Workbooks: opening, reading, editing and saving `.xlsx` files, CSV import
 * and export, number format rendering and A1 addressing.
 * Implements the contract in `../api/xlsx.ts`.
 *
 * Calculation uses the formula engine in `./formula/` with its whole
 * function library; proposed changes are kept by the journal in `./journal/`.
 */

import type { CreateXlsx, OpenXlsx, XlsxModule } from "../api/xlsx.js";
import { OfficeError } from "../errors.js";
import { makeParseCsv, toCsv } from "./csv/index.js";
import { formatValue } from "./format/index.js";
import * as formula from "./formula/index.js";
import { changeJournalProvider } from "./journal/index.js";
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
import { attachJournal, getJournalProvider, getWorkbookInternals, setJournalProvider } from "./workbook/internals.js";
import { type WorkbookDeps, createState, openState } from "./workbook/open.js";
import { checkSheetNameText } from "./workbook/sheets.js";
import { createHandle } from "./workbook/workbook.js";

export type * from "../api/xlsx.js";
export { formatValueDetailed, isDateFormat, isoToSerial, partsToSerial, serialToIso, serialToParts } from "./format/index.js";
export type { DateParts, FormattedValue } from "./format/index.js";
export { quoteSheetName } from "./workbook/a1.js";

const deps: WorkbookDeps = { formula };

export const openXlsx: OpenXlsx = async (bytes, options) => {
  const handle = createHandle(await openState(bytes, options, deps));
  const provider = getJournalProvider();
  if (provider !== null) attachJournal(handle, await provider.open(getWorkbookInternals(handle)));
  return handle;
};

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
  const handle = createHandle(createState(checked, deps));
  const provider = getJournalProvider();
  if (provider !== null) attachJournal(handle, provider.create(getWorkbookInternals(handle)));
  return handle;
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

// The change journal. Registered here, in a statement of this module, so a
// bundler that drops unused re-exports cannot drop the registration with them.
setJournalProvider(changeJournalProvider);

export {
  JOURNAL_CONTENT_TYPE,
  JOURNAL_PART_NAME,
  JOURNAL_RELATIONSHIP_TYPE,
  getJournalWarnings,
  listJournalChanges,
} from "./journal/index.js";
export type { JournalChange, JournalChangeKind, JournalResolveResult, JournalWarning, JournalWarningCode } from "./journal/index.js";
