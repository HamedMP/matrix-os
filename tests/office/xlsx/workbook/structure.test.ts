import { describe, expect, it } from "vitest";
import type { Workbook } from "../../../../packages/office/src/api/xlsx.js";
import { formatA1Range, openXlsx, parseA1, parseA1Range } from "../../../../packages/office/src/xlsx/index.js";
import { at, buildXlsx, codeOf, err, fx, loadFixture, num, sheetId, valueAt } from "./helpers.js";

/** Two sheets with formulas that point within a sheet and across sheets, merges, sizes and a defined name. */
async function ledger(): Promise<Workbook> {
  return openXlsx(
    await buildXlsx({
      sheets: [
        {
          name: "Data",
          before: '<cols><col min="2" max="3" width="20" customWidth="1"/></cols>',
          rows:
            `<row r="1">${num("A1", 1)}${num("B1", 10)}${fx("C1", "A1+B1", 11)}</row>` +
            `<row r="2">${num("A2", 2)}${num("B2", 20)}${fx("C2", "A2+B2", 22)}</row>` +
            `<row r="3" ht="30" customHeight="1">${num("A3", 3)}${num("B3", 30)}${fx("C3", "A3+B3", 33)}</row>` +
            `<row r="4">${num("A4", 4)}${num("B4", 40)}${fx("C4", "A4+B4", 44)}</row>` +
            `<row r="5">${fx("A5", "SUM(A1:A4)", 10)}${fx("B5", "SUM($B$1:$B$4)", 100)}${fx("C5", "SUM(C1:C4)", 110)}</row>` +
            `<row r="7">${fx("A7", "A3*2", 6)}${fx("B7", "SUM(A:A)", 26)}${fx("C7", "SUM(2:3)", 110)}</row>`,
          after:
            '<mergeCells count="2"><mergeCell ref="E2:F3"/><mergeCell ref="E6:F6"/></mergeCells>' +
            '<conditionalFormatting sqref="A1:A4"><cfRule type="expression" priority="1"><formula>$A1&gt;2</formula></cfRule></conditionalFormatting>' +
            '<dataValidations count="1"><dataValidation type="whole" sqref="B3"><formula1>0</formula1></dataValidation></dataValidations>',
        },
        {
          name: "Report",
          rows: `<row r="1">${fx("A1", "Data!A3", 3)}${fx("B1", "SUM(Data!A1:A4)", 10)}${fx("C1", "Total*2", 20)}${fx("D1", "A1+1", 4)}</row>`,
        },
      ],
      definedNames: '<definedName name="Total">Data!$A$5</definedName><definedName name="Block">Data!$A$2:$C$3</definedName>',
    }),
  );
}

const formulaAt = (workbook: Workbook, sheet: string, a1: string) => at(workbook, sheet, a1).formula;
const names = (workbook: Workbook) => Object.fromEntries(workbook.listDefinedNames().map((name) => [name.name, name.refersTo]));
const merges = (workbook: Workbook, sheet: string) => workbook.getSheet(sheetId(workbook, sheet)).mergedRanges.map(formatA1Range);

describe("inserting rows", () => {
  it("moves cells, sizes and merges, and rewrites references across the workbook", async () => {
    const workbook = await ledger();
    workbook.insertRows(sheetId(workbook, "Data"), 2, 2);
    // Cells below the insertion moved down with their values and row height.
    expect(valueAt(workbook, "Data", "A3")).toBeNull();
    expect(valueAt(workbook, "Data", "A5")).toBe(3);
    expect(formulaAt(workbook, "Data", "C5")).toBe("A5+B5");
    expect(formulaAt(workbook, "Data", "C2")).toBe("A2+B2");
    expect(formulaAt(workbook, "Data", "A7")).toBe("SUM(A1:A6)");
    expect(formulaAt(workbook, "Data", "B7")).toBe("SUM($B$1:$B$6)");
    expect(formulaAt(workbook, "Data", "A9")).toBe("A5*2");
    expect(formulaAt(workbook, "Data", "B9")).toBe("SUM(A:A)");
    expect(formulaAt(workbook, "Data", "C9")).toBe("SUM(2:5)");
    expect(workbook.getSheet(sheetId(workbook, "Data")).rows).toEqual([{ index: 4, heightPt: 30, hidden: false }]);
    expect(merges(workbook, "Data")).toEqual(["E2:F5", "E8:F8"]);
    // Other sheets and defined names follow.
    expect(formulaAt(workbook, "Report", "A1")).toBe("Data!A5");
    expect(formulaAt(workbook, "Report", "B1")).toBe("SUM(Data!A1:A6)");
    expect(formulaAt(workbook, "Report", "D1")).toBe("A1+1");
    expect(names(workbook)).toEqual({ Total: "Data!$A$7", Block: "Data!$A$2:$C$5" });
    // Values are unchanged by the move.
    const result = workbook.recalc();
    expect(result.changed).toEqual([]);
    expect(valueAt(workbook, "Data", "A7")).toBe(10);
    expect(valueAt(workbook, "Report", "C1")).toBe(20);

    const reopened = await openXlsx(await workbook.save());
    expect(formulaAt(reopened, "Data", "A7")).toBe("SUM(A1:A6)");
    expect(valueAt(reopened, "Data", "B5")).toBe(30);
    expect(merges(reopened, "Data")).toEqual(["E2:F5", "E8:F8"]);
    expect(names(reopened)).toEqual({ Total: "Data!$A$7", Block: "Data!$A$2:$C$5" });
    const xml = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).toContain('<row r="5" ht="30" customHeight="1"><c r="A5"><v>3</v></c>');
    expect(xml).toContain('<conditionalFormatting sqref="A1:A6">');
    expect(xml).toContain('<dataValidation type="whole" sqref="B5">');
    expect(xml).not.toContain('<row r="3"');
  });

  it("refuses to push cells off the sheet", async () => {
    const workbook = await ledger();
    const data = sheetId(workbook, "Data");
    workbook.setCell(data, parseA1("A1048576"), 1);
    expect(codeOf(() => workbook.insertRows(data, 0, 1))).toBe("invalid_operation");
    expect(codeOf(() => workbook.insertRows(data, 0, 0))).toBe("invalid_argument");
    expect(codeOf(() => workbook.insertRows(data, -1, 1))).toBe("invalid_argument");
    expect(codeOf(() => workbook.insertRows(data, 1048576, 1))).toBe("invalid_argument");
    expect(codeOf(() => workbook.insertRows("nope", 0, 1))).toBe("not_found");
    expect(valueAt(workbook, "Data", "A1")).toBe(1);
  });
});

describe("deleting rows", () => {
  it("removes cells, shrinks ranges and turns references to deleted cells into #REF!", async () => {
    const workbook = await ledger();
    workbook.deleteRows(sheetId(workbook, "Data"), 2, 1);
    expect(valueAt(workbook, "Data", "A3")).toBe(4);
    expect(formulaAt(workbook, "Data", "C3")).toBe("A3+B3");
    expect(formulaAt(workbook, "Data", "A4")).toBe("SUM(A1:A3)");
    expect(formulaAt(workbook, "Data", "B4")).toBe("SUM($B$1:$B$3)");
    expect(formulaAt(workbook, "Data", "A6")).toBe("#REF!*2");
    expect(formulaAt(workbook, "Data", "C6")).toBe("SUM(2:2)");
    expect(formulaAt(workbook, "Report", "A1")).toBe("#REF!");
    expect(formulaAt(workbook, "Report", "B1")).toBe("SUM(Data!A1:A3)");
    expect(names(workbook)).toEqual({ Total: "Data!$A$4", Block: "Data!$A$2:$C$2" });
    expect(merges(workbook, "Data")).toEqual(["E2:F2", "E5:F5"]);
    expect(workbook.getSheet(sheetId(workbook, "Data")).rows).toEqual([]);
    workbook.recalc();
    expect(valueAt(workbook, "Data", "A4")).toBe(7);
    expect(valueAt(workbook, "Data", "A6")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Report", "A1")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Report", "D1")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Report", "B1")).toBe(7);
    expect(valueAt(workbook, "Report", "C1")).toBe(14);

    const reopened = await openXlsx(await workbook.save());
    expect(at(reopened, "Report", "A1")).toMatchObject({ formula: "#REF!", value: err("#REF!") });
    expect(valueAt(reopened, "Data", "A4")).toBe(7);
    const xml = await reopened.package.getPartText("/xl/worksheets/sheet1.xml");
    expect(xml).toContain('<conditionalFormatting sqref="A1:A3">');
    expect(xml).not.toContain("dataValidation");
  });

  it("drops merges and names ranges that are deleted whole", async () => {
    const workbook = await ledger();
    workbook.deleteRows(sheetId(workbook, "Data"), 1, 2);
    expect(merges(workbook, "Data")).toEqual(["E4:F4"]);
    expect(names(workbook)).toEqual({ Total: "Data!$A$3", Block: "#REF!" });
    expect(formulaAt(workbook, "Data", "A3")).toBe("SUM(A1:A2)");
    expect(formulaAt(workbook, "Data", "C5")).toBe("SUM(#REF!)");
  });
});

describe("inserting and deleting columns", () => {
  it("inserts columns", async () => {
    const workbook = await ledger();
    workbook.insertColumns(sheetId(workbook, "Data"), 1, 1);
    expect(valueAt(workbook, "Data", "B1")).toBeNull();
    expect(valueAt(workbook, "Data", "C1")).toBe(10);
    expect(formulaAt(workbook, "Data", "D1")).toBe("A1+C1");
    expect(formulaAt(workbook, "Data", "C5")).toBe("SUM($C$1:$C$4)");
    expect(formulaAt(workbook, "Data", "C7")).toBe("SUM(A:A)");
    expect(formulaAt(workbook, "Data", "D7")).toBe("SUM(2:3)");
    expect(formulaAt(workbook, "Report", "B1")).toBe("SUM(Data!A1:A4)");
    expect(names(workbook)).toEqual({ Total: "Data!$A$5", Block: "Data!$A$2:$D$3" });
    expect(merges(workbook, "Data")).toEqual(["F2:G3", "F6:G6"]);
    expect(workbook.getSheet(sheetId(workbook, "Data")).columns.map((column) => column.index)).toEqual([2, 3]);
    expect(workbook.recalc().changed).toEqual([]);
    const reopened = await openXlsx(await workbook.save());
    expect(formulaAt(reopened, "Data", "D1")).toBe("A1+C1");
    expect(valueAt(reopened, "Data", "D5")).toBe(110);
    expect(await reopened.package.getPartText("/xl/worksheets/sheet1.xml")).toContain('<cols><col min="3" max="4" width="20" customWidth="1"/></cols>');
  });

  it("deletes columns", async () => {
    const workbook = await ledger();
    workbook.deleteColumns(sheetId(workbook, "Data"), 0, 1);
    expect(valueAt(workbook, "Data", "A1")).toBe(10);
    expect(formulaAt(workbook, "Data", "B1")).toBe("#REF!+A1");
    expect(formulaAt(workbook, "Data", "A5")).toBe("SUM($A$1:$A$4)");
    expect(formulaAt(workbook, "Data", "A7")).toBe("SUM(#REF!)");
    expect(formulaAt(workbook, "Report", "A1")).toBe("#REF!");
    expect(formulaAt(workbook, "Report", "B1")).toBe("SUM(#REF!)");
    expect(names(workbook)).toEqual({ Total: "#REF!", Block: "Data!$A$2:$B$3" });
    expect(merges(workbook, "Data")).toEqual(["D2:E3", "D6:E6"]);
    expect(workbook.getSheet(sheetId(workbook, "Data")).columns.map((column) => column.index)).toEqual([0, 1]);
    workbook.recalc();
    expect(valueAt(workbook, "Data", "A5")).toBe(100);
    expect(valueAt(workbook, "Data", "B1")).toEqual(err("#REF!"));
  });
});

describe("structural edits on real files", () => {
  it("keeps the array formula range in step and other sheets byte-identical when nothing refers to the sheet", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    workbook.insertRows(sheetId(workbook, "Calc"), 0, 3);
    expect(at(workbook, "Calc", "D5")).toMatchObject({ formula: "Data!C2:C6*Data!D2:D6", formulaUnsupported: false, value: 500 });
    expect(at(workbook, "Data", "F2").formula).toBe("E2*(1+Calc!$B$9)");
    expect(workbook.listDefinedNames()).toEqual([{ name: "TaxRate", refersTo: "Calc!$B$9", scope: null }]);
    const reopened = await openXlsx(await workbook.save());
    expect(await reopened.package.getPartText("/xl/worksheets/sheet2.xml")).toContain('<c r="D5"><f t="array" ref="D5:D9">Data!C2:C6*Data!D2:D6</f><v>500</v></c>');
    expect(valueAt(reopened, "Calc", "B9")).toBe(0.2);
    expect(valueAt(reopened, "Data", "F2")).toBe(600);
  });

  it("round-trips an insert followed by the matching delete", async () => {
    const workbook = await openXlsx(loadFixture("model.xlsx"));
    const projection = sheetId(workbook, "Projection");
    const before = workbook.getRange(projection, parseA1Range("A1:N10")).map((line) => line.map((cell) => [cell.value, cell.formula]));
    workbook.insertRows(projection, 4, 3);
    workbook.insertColumns(projection, 2, 2);
    expect(at(workbook, "Summary", "B3").formula).toBe("Projection!P13");
    workbook.deleteColumns(projection, 2, 2);
    workbook.deleteRows(projection, 4, 3);
    expect(workbook.getRange(projection, parseA1Range("A1:N10")).map((line) => line.map((cell) => [cell.value, cell.formula]))).toEqual(before);
    expect(at(workbook, "Summary", "B3").formula).toBe("Projection!N10");
  });
});
