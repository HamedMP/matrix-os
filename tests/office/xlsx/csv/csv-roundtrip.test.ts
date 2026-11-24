/**
 * A CSV file that is opened, edited in one place and written back.
 *
 * Outcome protected: the fields nobody touched come back as they were
 * written, and a date stays a date. Fault detected: typed values written in
 * their stored form (a date as its serial number, `10.00` as `10`).
 */

import { describe, expect, it } from "vitest";
import { createXlsx, parseA1, parseCsv, toCsv } from "../../../../packages/office/src/xlsx/index.js";

const SOURCE =
  "id,date,when,price,flag,code,note\n" +
  '1,2026-03-14,2026-03-14 15:09,10.00,true,007,"a ""q"", b"\n' +
  "2,2024-02-29,2024-02-29T08:00:00,0.10,False,1e3,=1+1\n" +
  "3,1900-01-01,,1234567890123456,,-0, lead";

describe("parseCsv then toCsv with the defaults", () => {
  it("writes an untouched file back as it was", () => {
    const workbook = parseCsv(SOURCE);
    const sheet = workbook.listSheets()[0]!.id;
    // The values are typed: this is about how they are written, not how they are held.
    expect(workbook.getCell(sheet, parseA1("B2")).value).toBe(46095);
    expect(workbook.getCell(sheet, parseA1("D2")).value).toBe(10);
    expect(toCsv(workbook, sheet, { lineEnding: "\n" })).toBe(SOURCE);
  });

  it("changes only the edited field", () => {
    const workbook = parseCsv(SOURCE);
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setCell(sheet, parseA1("G4"), "edited");
    workbook.setCell(sheet, parseA1("D3"), 0.25);
    workbook.recalc();
    const lines = toCsv(workbook, sheet, { lineEnding: "\n" }).split("\n");
    expect(lines[1]).toBe(SOURCE.split("\n")[1]);
    expect(lines[2]).toBe("2,2024-02-29,2024-02-29T08:00:00,0.25,False,1e3,=1+1");
    expect(lines[3]).toBe("3,1900-01-01,,1234567890123456,,-0,edited");
  });

  it("keeps each field with its row when rows and columns move", () => {
    const workbook = parseCsv(SOURCE);
    const sheet = workbook.listSheets()[0]!.id;
    workbook.insertRows(sheet, 1, 1);
    workbook.deleteColumns(sheet, 0, 1);
    workbook.recalc();
    const lines = toCsv(workbook, sheet, { lineEnding: "\n" }).split("\n");
    expect(lines[2]).toBe('2026-03-14,2026-03-14 15:09,10.00,true,007,"a ""q"", b"');
    expect(lines[3]).toBe("2024-02-29,2024-02-29T08:00:00,0.10,False,1e3,=1+1");
  });

  it("writes a date that was typed or calculated as a date", () => {
    const workbook = parseCsv("day,next\n2026-03-14,\n");
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setCellInput(sheet, parseA1("A3"), "2026-12-25");
    workbook.setCell(sheet, parseA1("A2"), 46096);
    workbook.setFormula(sheet, parseA1("B2"), "A2+1");
    workbook.setStyle(sheet, { start: parseA1("B2"), end: parseA1("B2") }, { numberFormat: "d mmm yyyy" });
    workbook.setCell(sheet, parseA1("B3"), 46096.5);
    workbook.setStyle(sheet, { start: parseA1("B3"), end: parseA1("B3") }, { numberFormat: "yyyy-mm-dd hh:mm" });
    workbook.recalc();
    const text = toCsv(workbook, sheet, { lineEnding: "\n" });
    expect(text).toBe("day,next\n2026-03-15,2026-03-16\n2026-12-25,2026-03-15 12:00:00");
    // What was written reads back as the same dates.
    const again = parseCsv(text);
    const id = again.listSheets()[0]!.id;
    expect(again.getCell(id, parseA1("A2")).value).toBe(46096);
    expect(again.getCell(id, parseA1("B3")).value).toBe(46096.5);
  });

  it("leaves a workbook that is not a CSV file to the caller's choice of raw or display", () => {
    const workbook = createXlsx();
    const sheet = workbook.listSheets()[0]!.id;
    workbook.setCellInput(sheet, parseA1("A1"), "2026-03-14");
    expect(toCsv(workbook, sheet)).toBe("46095");
    expect(toCsv(workbook, sheet, { values: "display" })).toBe(workbook.getCell(sheet, parseA1("A1")).display);
  });
});
