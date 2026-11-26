// @vitest-environment jsdom
/**
 * Workbooks of the 1904 date system (older Mac files) store a date as the
 * days since 1904-01-01. The cell editor, the formula bar and Find in
 * formulas show a date as the text that types it back, so they must read the
 * serial in the workbook's own system: a 1900 reading shows it 1,462 days
 * early, and changing only the day would then store the wrong date.
 */
import { describe, expect, it } from "vitest";
import { createSheetGridController, editTextOf } from "../../../../home/apps/sheets/src/grid";
import { updateEditText } from "../../../../home/apps/sheets/src/grid/actions-edit";
import { createSheetSession } from "../../../../home/apps/sheets/src/session";
import { usesDate1904 } from "../../../../home/apps/sheets/src/session/date-system";
import { openXlsx } from "../../../../home/apps/sheets/src/session/engine";
import { findMatches } from "../../../../home/apps/sheets/src/ui/find-replace";
import { buildXlsx } from "../../../office/xlsx/workbook/helpers";
import { harness } from "../session/fakes";

const STYLES =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>';

/** A1 holds serial 44633 shown as a date: 2026-03-14 in the 1904 system, 2022-03-13 in the 1900 one. */
async function workbookOf(date1904: boolean) {
  const bytes = await buildXlsx({
    sheets: [{ name: "S", rows: '<row r="1"><c r="A1" s="1"><v>44633</v></c></row>' }],
    workbookPr: date1904 ? ' date1904="1"' : "",
    styles: STYLES,
  });
  return openXlsx(bytes);
}

async function setup(date1904: boolean) {
  const workbook = await workbookOf(date1904);
  const session = createSheetSession(harness().deps, { workbook });
  const controller = createSheetGridController(session);
  const sheet = session.getState().activeSheetId;
  controller.select({ row: 0, col: 0 });
  return { session, controller, sheet };
}

describe("dates of the 1904 date system", () => {
  it("knows the date system of each workbook", async () => {
    expect(usesDate1904(await workbookOf(true))).toBe(true);
    expect(usesDate1904(await workbookOf(false))).toBe(false);
  });

  it("writes a serial as the date of the system it is given", () => {
    expect(editTextOf({ value: 44633, formula: null }, "mm-dd-yy", true)).toBe("2026-03-14");
    expect(editTextOf({ value: 44633, formula: null }, "mm-dd-yy", false)).toBe("2022-03-13");
  });

  it("opens the cell editor on the date the cell shows, and keeps it when committed unchanged", async () => {
    const { session, controller, sheet } = await setup(true);
    controller.startEdit();
    expect(controller.context.store.getState().edit?.text).toBe("2026-03-14");
    expect(controller.commitEdit()).toBe(true);
    expect(session.cell(sheet, 0, 0).value).toBe(44633);
  });

  it("stores the next day when only the day is changed", async () => {
    const { session, controller, sheet } = await setup(true);
    controller.startEdit();
    const text = controller.context.store.getState().edit?.text ?? "";
    const next = text.replace(/14$/, "15");
    updateEditText(controller.context, next, next.length, next.length);
    expect(controller.commitEdit()).toBe(true);
    expect(session.cell(sheet, 0, 0).value).toBe(44634);
  });

  it("finds a date in formulas by the date the cell shows", async () => {
    const { session, sheet } = await setup(true);
    const options = { matchCase: false, wholeCell: false, lookIn: "formulas" as const };
    expect(findMatches(session, sheet, { ...options, query: "2026-03-14" }).matches).toEqual([{ row: 0, col: 0 }]);
    expect(findMatches(session, sheet, { ...options, query: "2022-03-13" }).matches).toEqual([]);
  });

  it("still reads 1900 workbooks in the 1900 system", async () => {
    const { controller } = await setup(false);
    controller.startEdit();
    expect(controller.context.store.getState().edit?.text).toBe("2022-03-13");
  });
});
