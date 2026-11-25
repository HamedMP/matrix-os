import { describe, expect, it } from "vitest";
import { createXlsx, openXlsx, parseA1 } from "../../../../packages/office/src/xlsx/index.js";
import type { XlsxModule } from "../../../../packages/office/src/api/xlsx.js";
import * as xlsx from "../../../../packages/office/src/xlsx/index.js";
import { at, buildXlsx, codeOf, err, fx, loadFixture, num, sheetId, storedRecords, valueAt } from "./helpers.js";

describe("the module contract", () => {
  it("exports everything the contract names", () => {
    const contract: XlsxModule = xlsx;
    expect(contract.MAX_ROWS).toBe(1048576);
    expect(contract.MAX_COLS).toBe(16384);
    expect(Object.keys(xlsx.xlsxModule).sort()).toEqual(
      ["MAX_COLS", "MAX_ROWS", "columnIndex", "columnLabel", "createXlsx", "formatA1", "formatA1Range", "formatValue", "openXlsx", "parseA1", "parseA1Range", "parseCsv", "parseSheetRange", "toCsv"].sort(),
    );
  });
});

describe("createXlsx", () => {
  it("creates one sheet named Sheet1, or the sheets asked for", async () => {
    const workbook = createXlsx();
    expect(workbook.listSheets()).toEqual([
      {
        id: "1",
        name: "Sheet1",
        index: 0,
        state: "visible",
        dimensions: null,
        defaultColumnWidth: 8.43,
        defaultRowHeightPt: 15,
        columns: [],
        rows: [],
        mergedRanges: [],
        frozen: { rows: 0, cols: 0 },
        pendingChangeCount: 0,
      },
    ]);
    const named = createXlsx({ sheetNames: ["Plan", "Q&A <1>", "Données"] });
    expect(named.listSheets().map((sheet) => [sheet.id, sheet.name])).toEqual([
      ["1", "Plan"],
      ["2", "Q&A <1>"],
      ["3", "Données"],
    ]);
    const reopened = await openXlsx(await named.save());
    expect(reopened.listSheets().map((sheet) => sheet.name)).toEqual(["Plan", "Q&A <1>", "Données"]);
    expect(reopened.listDefinedNames()).toEqual([]);
    expect(reopened.getStyle(0).font).toMatchObject({ name: "Calibri", sizePt: 11, color: null });
  });

  it("saves deterministically", async () => {
    const make = async () => {
      const workbook = createXlsx({ sheetNames: ["A", "B"] });
      workbook.setRange(workbook.listSheets()[0]!.id, parseA1("A1"), [["x", 1], ["y", 2]]);
      workbook.setFormula(workbook.listSheets()[1]!.id, parseA1("A1"), "SUM(A!B1:B2)");
      return workbook.save();
    };
    expect(storedRecords(await make())).toEqual(storedRecords(await make()));
  });

  it("rejects bad sheet names", () => {
    expect(codeOf(() => createXlsx({ sheetNames: [] }))).toBe("invalid_argument");
    expect(codeOf(() => createXlsx({ sheetNames: ["a", "A"] }))).toBe("invalid_argument");
    expect(codeOf(() => createXlsx({ sheetNames: ["a/b"] }))).toBe("invalid_argument");
    expect(codeOf(() => createXlsx({ sheetNames: [""] }))).toBe("invalid_argument");
    expect(codeOf(() => createXlsx({ sheetNames: ["x".repeat(32)] }))).toBe("invalid_argument");
    expect(codeOf(() => createXlsx({ sheetNames: [5 as never] }))).toBe("invalid_argument");
  });
});

describe("adding, renaming and removing sheets", () => {
  it("adds sheets at the end or at a position", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    const last = workbook.addSheet("Last");
    const second = workbook.addSheet("Second", 1);
    expect(last).toMatchObject({ id: "6", name: "Last", index: 5, dimensions: null });
    expect(second).toMatchObject({ id: "7", name: "Second", index: 1 });
    expect(workbook.listSheets().map((sheet) => sheet.name)).toEqual(["Summary", "Second", "Q1 Sales", "Q2 Sales", "O'Brien Notes", "Hidden Lookup", "Last"]);
    workbook.setCell(second.id, parseA1("B2"), "on the new sheet");
    workbook.setFormula(last.id, parseA1("A1"), "Second!B2&\"!\"");
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.listSheets().map((sheet) => [sheet.id, sheet.name])).toEqual([
      ["1", "Summary"],
      ["7", "Second"],
      ["2", "Q1 Sales"],
      ["3", "Q2 Sales"],
      ["4", "O'Brien Notes"],
      ["5", "Hidden Lookup"],
      ["6", "Last"],
    ]);
    expect(valueAt(reopened, "Second", "B2")).toBe("on the new sheet");
    expect(valueAt(reopened, "Last", "A1")).toBe("on the new sheet!");
    expect(valueAt(reopened, "Summary", "B4")).toBe(915);
    expect(reopened.package.hasPart("/xl/worksheets/sheet6.xml")).toBe(true);
    expect(reopened.package.hasPart("/xl/worksheets/sheet7.xml")).toBe(true);
  });

  it("checks sheet names", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    for (const name of ["", "x".repeat(32), "a:b", "a\\b", "a/b", "a?b", "a*b", "a[b", "a]b", "'quoted", "summary", "Q1 SALES"]) {
      expect(codeOf(() => workbook.addSheet(name)), name).toBe("invalid_argument");
    }
    expect(codeOf(() => workbook.addSheet("ok", 99))).toBe("invalid_argument");
    expect(codeOf(() => workbook.renameSheet(sheetId(workbook, "Summary"), "Q2 Sales"))).toBe("invalid_argument");
    expect(codeOf(() => workbook.renameSheet("nope", "x"))).toBe("not_found");
    expect(workbook.listSheets().length).toBe(5);
  });

  it("renames a sheet and every reference to it", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    workbook.renameSheet(sheetId(workbook, "Q1 Sales"), "First");
    workbook.renameSheet(sheetId(workbook, "O'Brien Notes"), "Notes & more");
    // A change of case only is a rename too.
    workbook.renameSheet(sheetId(workbook, "Summary"), "SUMMARY");
    expect(at(workbook, "SUMMARY", "B2").formula).toBe("First!B6");
    expect(at(workbook, "summary", "B4").formula).toBe("SUM(First!B2:B5,'Q2 Sales'!B2:B5)");
    expect(at(workbook, "Summary", "B7").formula).toBe("'Notes & more'!A1");
    expect(workbook.getSheetByName("Q1 Sales")).toBeNull();
    expect(workbook.recalc().changed).toEqual([]);
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.listSheets().map((sheet) => [sheet.id, sheet.name])).toEqual([
      ["1", "SUMMARY"],
      ["2", "First"],
      ["3", "Q2 Sales"],
      ["4", "Notes & more"],
      ["5", "Hidden Lookup"],
    ]);
    expect(at(reopened, "SUMMARY", "B2")).toMatchObject({ formula: "First!B6", value: 446 });
    expect(at(reopened, "SUMMARY", "B7")).toMatchObject({ formula: "'Notes & more'!A1", value: "Figures checked by the regional leads." });
  });

  it("removes a sheet, its part and its relationship; references become #REF!", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    workbook.removeSheet(sheetId(workbook, "Q2 Sales"));
    expect(workbook.listSheets().map((sheet) => sheet.name)).toEqual(["Summary", "Q1 Sales", "O'Brien Notes", "Hidden Lookup"]);
    expect(at(workbook, "Summary", "B3").formula).toBe("#REF!");
    expect(at(workbook, "Summary", "B4").formula).toBe("SUM('Q1 Sales'!B2:B5,#REF!)");
    expect(at(workbook, "Summary", "B2").formula).toBe("'Q1 Sales'!B6");
    workbook.recalc();
    expect(valueAt(workbook, "Summary", "B3")).toEqual(err("#REF!"));
    expect(valueAt(workbook, "Summary", "B2")).toBe(446);
    const reopened = await openXlsx(await workbook.save());
    expect(reopened.package.hasPart("/xl/worksheets/sheet3.xml")).toBe(false);
    expect(reopened.package.getRelationships("/xl/workbook.xml").some((relationship) => relationship.target.includes("sheet3"))).toBe(false);
    expect(reopened.package.getContentTypes().overrides.some((entry) => entry.partName.includes("sheet3"))).toBe(false);
    expect(reopened.listSheets().map((sheet) => sheet.id)).toEqual(["1", "2", "4", "5"]);
    expect(codeOf(() => workbook.getSheet("3"))).toBe("not_found");
  });

  it("keeps at least one visible sheet", async () => {
    const workbook = await openXlsx(await buildXlsx({ sheets: [{ name: "Shown" }, { name: "Hidden", state: "hidden" }] }));
    expect(codeOf(() => workbook.removeSheet(sheetId(workbook, "Shown")))).toBe("invalid_operation");
    workbook.removeSheet(sheetId(workbook, "Hidden"));
    expect(codeOf(() => workbook.removeSheet(sheetId(workbook, "Shown")))).toBe("invalid_operation");
    expect(workbook.listSheets().length).toBe(1);
  });
});

describe("defined names", () => {
  const source = () =>
    buildXlsx({
      sheets: [
        { name: "One", rows: `<row r="1">${num("A1", 5)}${fx("B1", "Rate*A1", 10)}${fx("C1", "Local+1", 8)}</row>` },
        { name: "Two", rows: `<row r="1">${num("A1", 100)}${fx("B1", "Local+1", 101)}</row>` },
      ],
      definedNames:
        '<definedName name="Rate">2</definedName>' +
        '<definedName name="Local" localSheetId="0">One!$A$1+2</definedName>' +
        '<definedName name="Local" localSheetId="1">Two!$A$1</definedName>' +
        '<definedName name="_xlnm.Print_Area" localSheetId="1">Two!$A$1:$B$1</definedName>',
    });

  it("lists names with their scope and resolves the nearest one", async () => {
    const workbook = await openXlsx(await source());
    const one = sheetId(workbook, "One");
    const two = sheetId(workbook, "Two");
    expect(workbook.listDefinedNames()).toEqual([
      { name: "Rate", refersTo: "2", scope: null },
      { name: "Local", refersTo: "One!$A$1+2", scope: one },
      { name: "Local", refersTo: "Two!$A$1", scope: two },
      { name: "_xlnm.Print_Area", refersTo: "Two!$A$1:$B$1", scope: two },
    ]);
    workbook.setCell(one, parseA1("A1"), 6);
    workbook.setCell(two, parseA1("A1"), 200);
    workbook.recalc();
    expect(valueAt(workbook, "One", "B1")).toBe(12);
    expect(valueAt(workbook, "One", "C1")).toBe(9);
    expect(valueAt(workbook, "Two", "B1")).toBe(201);
  });

  it("adds, replaces and removes names, and recalculates what uses them", async () => {
    const workbook = await openXlsx(await source());
    const one = sheetId(workbook, "One");
    workbook.setDefinedName({ name: "rate", refersTo: "=3", scope: null });
    workbook.setDefinedName({ name: "Fresh", refersTo: "One!$A$1*10", scope: null });
    workbook.setDefinedName({ name: "Fresh", refersTo: "One!$A$1*100", scope: one });
    workbook.setFormula(one, parseA1("D1"), "Fresh");
    workbook.setFormula(sheetId(workbook, "Two"), parseA1("D1"), "Fresh");
    workbook.recalc();
    expect(valueAt(workbook, "One", "B1")).toBe(15);
    expect(valueAt(workbook, "One", "D1")).toBe(500);
    expect(valueAt(workbook, "Two", "D1")).toBe(50);
    expect(workbook.removeDefinedName("FRESH", one)).toBe(true);
    expect(workbook.removeDefinedName("Fresh", one)).toBe(false);
    expect(workbook.removeDefinedName("Nope")).toBe(false);
    workbook.recalc();
    expect(valueAt(workbook, "One", "D1")).toBe(50);
    expect(workbook.removeDefinedName("Fresh")).toBe(true);
    workbook.recalc();
    expect(valueAt(workbook, "One", "D1")).toEqual(err("#NAME?"));

    const reopened = await openXlsx(await workbook.save());
    expect(reopened.listDefinedNames().map((name) => [name.name, name.refersTo, name.scope])).toEqual([
      ["rate", "3", null],
      ["Local", "One!$A$1+2", "1"],
      ["Local", "Two!$A$1", "2"],
      ["_xlnm.Print_Area", "Two!$A$1:$B$1", "2"],
    ]);
    expect(await reopened.package.getPartText("/xl/workbook.xml")).toContain('<definedName name="rate">3</definedName><definedName name="Local" localSheetId="0">One!$A$1+2</definedName>');
  });

  it("evaluates a local name on its own sheet, for the functions it calls too", () => {
    const workbook = createXlsx({ sheetNames: ["Summary", "Inputs"] });
    const [summary, inputs] = workbook.listSheets().map((sheet) => sheet.id) as [string, string];
    workbook.setCell(summary, parseA1("A1"), 1);
    workbook.setCell(inputs, parseA1("A1"), 42);
    workbook.setDefinedName({ name: "Picked", refersTo: 'INDIRECT("A1")', scope: inputs });
    workbook.setDefinedName({ name: "Plain", refersTo: "A1", scope: inputs });
    workbook.setFormula(summary, parseA1("B1"), "Inputs!Picked");
    workbook.setFormula(summary, parseA1("B2"), "Inputs!Plain");
    workbook.recalc();
    expect([valueAt(workbook, "Summary", "B1"), valueAt(workbook, "Summary", "B2")]).toEqual([42, 42]);
  });

  it("keeps local names on their sheet when sheets are added and removed", async () => {
    const workbook = await openXlsx(await source());
    workbook.addSheet("Zero", 0);
    let reopened = await openXlsx(await workbook.save());
    expect(await reopened.package.getPartText("/xl/workbook.xml")).toContain('<definedName name="Local" localSheetId="1">One!$A$1+2</definedName><definedName name="Local" localSheetId="2">Two!$A$1</definedName>');
    reopened.removeSheet(sheetId(reopened, "One"));
    reopened = await openXlsx(await reopened.save());
    expect(reopened.listDefinedNames().map((name) => [name.name, name.refersTo, name.scope])).toEqual([
      ["Rate", "2", null],
      ["Local", "Two!$A$1", "2"],
      ["_xlnm.Print_Area", "Two!$A$1:$B$1", "2"],
    ]);
    reopened.removeSheet(sheetId(reopened, "Two"));
    reopened.removeDefinedName("Rate");
    reopened = await openXlsx(await reopened.save());
    expect(reopened.listDefinedNames()).toEqual([]);
    expect(await reopened.package.getPartText("/xl/workbook.xml")).not.toContain("definedName");
  });

  it("checks names", async () => {
    const workbook = createXlsx();
    for (const name of ["", "A1", "1abc", "has space", "TRUE", "R1C1", "a!b", "x".repeat(256)]) {
      expect(codeOf(() => workbook.setDefinedName({ name, refersTo: "1", scope: null })), name).toBe("invalid_argument");
    }
    expect(codeOf(() => workbook.setDefinedName({ name: "Ok", refersTo: "", scope: null }))).toBe("invalid_argument");
    expect(codeOf(() => workbook.setDefinedName({ name: "Ok", refersTo: "1", scope: "nope" }))).toBe("not_found");
    workbook.setDefinedName({ name: "Größe_2.x", refersTo: "Sheet1!$A$1", scope: null });
    expect(workbook.listDefinedNames()).toEqual([{ name: "Größe_2.x", refersTo: "Sheet1!$A$1", scope: null }]);
  });
});
