/**
 * The date system of a workbook. A spreadsheet stores a date as a serial
 * number of days: since 1899-12-30 in the 1900 system (the default), since
 * 1904-01-01 in the 1904 system that older Mac files use. Code that turns a
 * serial into date text, or date text into a serial, must use the workbook's
 * own system, or the date moves by 1,462 days.
 */

import { type Workbook, boolAttr, getAttr, getWorkbookInternals, kid } from "./engine";

/** The answer for each workbook: a workbook keeps the date system it was opened with. */
const known = new WeakMap<Workbook, boolean>();

/** True when the workbook counts its dates from 1904-01-01. */
export function usesDate1904(workbook: Workbook): boolean {
  let date1904 = known.get(workbook);
  if (date1904 === undefined) {
    const internals = getWorkbookInternals(workbook);
    const doc = internals.getPartXml(internals.workbookPartName);
    const properties = doc === null ? null : kid(doc.root, "workbookPr");
    date1904 = properties !== null && boolAttr(getAttr(properties, "date1904"), false);
    known.set(workbook, date1904);
  }
  return date1904;
}
