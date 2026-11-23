import type { Workbook } from "../../../../packages/office/src/api/xlsx.js";
import {
  type JournalChange,
  type JournalResolveResult,
  listJournalChanges,
} from "../../../../packages/office/src/xlsx/journal/index.js";
import { createXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";

export { at, codeOf, err, loadFixture, sheetId, valueAt } from "../workbook/helpers.js";

export const AGENT = { author: "Matrix agent", date: "2026-11-23T10:00:00Z", label: "Fix totals" };
export const OWNER = { author: "Owner", date: "2026-11-23T11:00:00Z", label: "Second pass" };

/** A one-sheet workbook: A1:A3 hold 1, 2, 3 and A4 sums them. */
export function smallBook(): { workbook: Workbook; sheet: string } {
  const workbook = createXlsx({ sheetNames: ["Data"] });
  const sheet = workbook.listSheets()[0]!.id;
  workbook.setRange(sheet, parseA1("A1"), [[1], [2], [3]]);
  workbook.setFormula(sheet, parseA1("A4"), "SUM(A1:A3)");
  workbook.recalc();
  return { workbook, sheet };
}

export function changes(workbook: Workbook): JournalChange[] {
  return listJournalChanges(workbook);
}

export function resolved(result: unknown): JournalResolveResult {
  return result as JournalResolveResult;
}

export const a1 = parseA1;
