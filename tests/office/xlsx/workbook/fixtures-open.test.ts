import { describe, expect, it } from "vitest";
import type { CellValue } from "../../../../packages/office/src/api/xlsx.js";
import { formatA1, formatA1Range, openXlsx } from "../../../../packages/office/src/xlsx/index.js";
import { at, err, loadExpected, loadFixture, sheetId, storedRecords, valueAt } from "./helpers.js";

interface SummaryFormula {
  cell: string;
  formula: string;
  type: "normal" | "shared" | "array";
  ref: string | null;
  cached: string | null;
}

interface SummarySheet {
  name: string;
  state: string;
  dimension: string;
  cells: number;
  formulaCount: number;
  formulas: SummaryFormula[];
  mergedCells: string[];
  frozenAt: string | null;
  columnWidths: Record<string, number>;
}

interface Summary {
  sheetNames: string[];
  definedNames: Record<string, string>;
  totalCells: number;
  totalFormulas: number;
  sheets: SummarySheet[];
}

const FIXTURES = ["basic.xlsx", "formulas.xlsx", "formats.xlsx", "multi-sheet.xlsx", "model.xlsx"];

/** A cached value as the independent validator prints it. */
function cachedText(value: CellValue): string | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "object") return value.code;
  return String(value);
}

describe.each(FIXTURES)("%s against the independent summary", (name) => {
  const summary = loadExpected<Summary>(`${name}.summary.json`);

  it("lists the same sheets, dimensions, merges, panes and column widths", async () => {
    const workbook = await openXlsx(loadFixture(name));
    const sheets = workbook.listSheets();
    expect(sheets.map((sheet) => sheet.name)).toEqual(summary.sheetNames);
    sheets.forEach((sheet, index) => {
      const expected = summary.sheets[index] as SummarySheet;
      expect(sheet.index).toBe(index);
      expect(sheet.state).toBe(expected.state);
      expect(sheet.dimensions === null ? null : formatA1Range(sheet.dimensions)).toBe(expected.dimension);
      expect(sheet.mergedRanges.map(formatA1Range)).toEqual(expected.mergedCells);
      const frozen = sheet.frozen.rows === 0 && sheet.frozen.cols === 0 ? null : formatA1({ row: sheet.frozen.rows, col: sheet.frozen.cols });
      expect(frozen).toBe(expected.frozenAt);
      expect(Object.fromEntries(sheet.columns.map((column) => [String(column.index + 1), column.width]))).toEqual(expected.columnWidths);
      expect(sheet.pendingChangeCount).toBe(0);
    });
  });

  it("reads every formula with its cached value, and the same number of cells", async () => {
    const workbook = await openXlsx(loadFixture(name));
    let cells = 0;
    let formulas = 0;
    for (const sheet of workbook.listSheets()) {
      const expected = summary.sheets[sheet.index] as SummarySheet;
      const found: SummaryFormula[] = [];
      let sheetCells = 0;
      if (sheet.dimensions !== null) {
        const grid = workbook.getRange(sheet.id, sheet.dimensions);
        grid.forEach((line, r) =>
          line.forEach((cell, c) => {
            if (cell.value !== null || cell.formula !== null) sheetCells++;
            if (cell.formula === null) return;
            const address = formatA1({ row: sheet.dimensions!.start.row + r, col: sheet.dimensions!.start.col + c });
            const wanted = expected.formulas.find((formula) => formula.cell === address);
            found.push({
              cell: address,
              formula: cell.formula,
              type: wanted?.type ?? "normal",
              ref: wanted?.ref ?? null,
              cached: cachedText(cell.value),
            });
          }),
        );
      }
      const byCell = (a: SummaryFormula, b: SummaryFormula) => a.cell.localeCompare(b.cell);
      expect(found.sort(byCell)).toEqual([...expected.formulas].sort(byCell));
      // The validator counts cells that hold a value; styled empty cells are not among them.
      expect(sheetCells).toBeLessThanOrEqual(expected.cells);
      cells += sheetCells;
      formulas += found.length;
    }
    expect(formulas).toBe(summary.totalFormulas);
    expect(cells).toBeLessThanOrEqual(summary.totalCells);
    expect(cells).toBeGreaterThan(summary.totalCells - 5);
  });

  it("lists the defined names", async () => {
    const workbook = await openXlsx(loadFixture(name));
    expect(Object.fromEntries(workbook.listDefinedNames().map((entry) => [entry.name, entry.refersTo]))).toEqual(summary.definedNames);
    for (const entry of workbook.listDefinedNames()) expect(entry.scope).toBeNull();
  });

  it("saves an unedited workbook with every part byte for byte as it was", async () => {
    const source = loadFixture(name);
    const before = storedRecords(source);
    const workbook = await openXlsx(source);
    // Reading does not make anything dirty.
    for (const sheet of workbook.listSheets()) {
      if (sheet.dimensions !== null) workbook.getRange(sheet.id, sheet.dimensions);
    }
    workbook.listDefinedNames();
    const saved = await workbook.save();
    const after = storedRecords(saved);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [entry, record] of before) expect(after.get(entry), entry).toEqual(record);
    for (const part of workbook.package.listParts({ includeRelationships: true })) expect(part.modified, part.name).toBe(false);
    // A second save of the same handle is identical too.
    expect(storedRecords(await workbook.save())).toEqual(after);
  });
});

describe("basic.xlsx values", () => {
  it("reads every cell type with its exact value and display text", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const cell = (a1: string) => at(workbook, "Basics", a1);
    expect(cell("A1")).toEqual({ value: "Label", formula: null, styleId: 0, display: "Label", formulaUnsupported: false, arrayRange: null, pendingChangeId: null });
    expect(cell("B2")).toMatchObject({ value: 42, display: "42" });
    expect(cell("B3")).toMatchObject({ value: -17, display: "-17" });
    expect(cell("B4")).toMatchObject({ value: 3.14159, display: "3.14159" });
    expect(cell("B5")).toMatchObject({ value: 1234567890123, display: "1.23457E+12" });
    expect(cell("B6")).toMatchObject({ value: "hello world", display: "hello world" });
    expect(cell("B7").value).toBe("hello world");
    expect(cell("B8").value).toBe("Grüße – 文档 😀");
    expect(cell("B9")).toMatchObject({ value: true, display: "TRUE" });
    expect(cell("B10")).toMatchObject({ value: false, display: "FALSE" });
    expect(cell("B11")).toMatchObject({ value: 46095, styleId: 1, display: "2026-03-14" });
    expect(cell("B12")).toMatchObject({ value: 46095.63155092593, styleId: 2, display: "2026-03-14 15:09:26" });
    expect(cell("B13")).toMatchObject({ value: "00123", display: "00123" });
    expect(cell("B14").value).toBe("Lorem ipsum ".repeat(20));
    expect(cell("E2").value).toBe("Gap after an empty column");
    expect(cell("A20").value).toBe("Isolated cell below empty rows");
    expect(cell("B21")).toMatchObject({ value: "Inline string cell", display: "Inline string cell" });
    // Empty cells inside and outside the used range.
    const empty = { value: null, formula: null, styleId: 0, display: "", formulaUnsupported: false, arrayRange: null, pendingChangeId: null };
    expect(cell("D2")).toEqual(empty);
    expect(cell("A15")).toEqual(empty);
    expect(cell("XFD1048576")).toEqual(empty);
  });

  it("returns ranges row by row", async () => {
    const workbook = await openXlsx(loadFixture("basic.xlsx"));
    const id = sheetId(workbook, "Basics");
    const grid = workbook.getRange(id, { start: { row: 1, col: 0 }, end: { row: 2, col: 2 } });
    expect(grid.map((line) => line.map((cell) => cell.value))).toEqual([
      ["Integer", 42, "number"],
      ["Negative", -17, "number"],
    ]);
    // Corners in any order.
    const flipped = workbook.getRange(id, { start: { row: 2, col: 2 }, end: { row: 1, col: 0 } });
    expect(flipped.map((line) => line.map((cell) => cell.value))).toEqual(grid.map((line) => line.map((cell) => cell.value)));
  });
});

describe("formulas.xlsx values", () => {
  it("reads formulas, their cached results and the array formula", async () => {
    const workbook = await openXlsx(loadFixture("formulas.xlsx"));
    expect(at(workbook, "Data", "E2")).toMatchObject({ value: 500, formula: "C2*D2", display: "500", formulaUnsupported: false });
    expect(at(workbook, "Data", "F4")).toMatchObject({ value: 287.856, formula: "E4*(1+Calc!$B$6)", display: "287.856" });
    expect(at(workbook, "Calc", "B1")).toMatchObject({ value: 237, formula: "SUM(Data!D2:D6)" });
    expect(at(workbook, "Calc", "B2")).toMatchObject({ value: 9.578, formula: "AVERAGE(Data!C2:C6)" });
    expect(at(workbook, "Calc", "B3")).toMatchObject({ value: "Yes", formula: 'IF(B1>100,"Yes","No")', display: "Yes" });
    expect(at(workbook, "Calc", "B8")).toMatchObject({ value: 1765.356, formula: "B7*(1+TaxRate)" });
    expect(at(workbook, "Calc", "B9")).toMatchObject({ value: true, formula: "B1>50", display: "TRUE" });
    expect(at(workbook, "Calc", "B10")).toMatchObject({ value: err("#N/A"), display: "#N/A" });
    expect(at(workbook, "Calc", "B6")).toMatchObject({ value: 0.2, formula: null });
    // The array formula sits in the first cell of its range; the rest of the range holds its values without a formula.
    expect(at(workbook, "Calc", "D2")).toMatchObject({ value: 500, formula: "Data!C2:C6*Data!D2:D6", formulaUnsupported: false });
    expect(at(workbook, "Calc", "D3")).toMatchObject({ value: 206.25, formula: null });
    expect(workbook.listDefinedNames()).toEqual([{ name: "TaxRate", refersTo: "Calc!$B$6", scope: null }]);
  });
});

describe("formats.xlsx values", () => {
  it("shows each value through its number format", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const shown = (a1: string) => at(workbook, "Formats", a1).display;
    expect(valueAt(workbook, "Formats", "A1")).toBe("Formatted values");
    expect(shown("B3")).toBe("$1,234.50 ");
    expect(shown("B4")).toBe("-£987.65");
    expect(shown("B5")).toBe("50,000.00 €");
    expect(shown("B6")).toBe("12.8%");
    expect(shown("B7")).toBe("2026-07-04");
    expect(shown("B8")).toBe("25 December 2026");
    expect(shown("B9")).toBe("2:30 PM");
    expect(shown("B10")).toBe("00042");
    expect(shown("B11")).toBe("-15,000");
    expect(shown("B12")).toBe("1.23E-04");
    expect(shown("B13")).toBe(" 3/4");
    expect(at(workbook, "Formats", "B14")).toMatchObject({ value: "007", display: "007" });
    // Styled cells without a value are cells with an empty display.
    expect(at(workbook, "Formats", "E2")).toMatchObject({ value: null, styleId: 2, display: "" });
  });

  it("resolves fonts, fills, borders, alignment and number formats", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const style = (a1: string) => workbook.getStyle(at(workbook, "Formats", a1).styleId);
    expect(style("A1")).toMatchObject({
      font: { name: "Arial", sizePt: 16, bold: true, italic: false, color: "#ffffff" },
      fill: { color: "#1f3a5f" },
      alignment: { horizontal: "center", vertical: "middle" },
      numberFormat: "General",
    });
    expect(style("A2")).toMatchObject({ font: { bold: true }, border: { bottom: { style: "thick", color: null }, top: { style: "none" } } });
    expect(style("B3")).toMatchObject({
      numberFormat: '"$"#,##0.00_);[Red]("$"#,##0.00)',
      border: { left: { style: "thin", color: "#999999" }, top: { style: "thin", color: "#999999" } },
    });
    expect(style("B4").numberFormat).toBe('"£"#,##0.00');
    expect(style("B9").numberFormat).toBe("h:mm AM/PM");
    expect(style("B14").numberFormat).toBe("@");
    expect(style("D3").alignment).toEqual({ horizontal: "general", vertical: "top", wrapText: true, indent: 0 });
    expect(style("D4").font).toEqual({ name: "Georgia", sizePt: 11, bold: false, italic: true, underline: true, strike: false, color: "#c00000" });
    expect(style("D6")).toMatchObject({ fill: { color: "#fff2cc" }, border: { bottom: { style: "double" } } });
    expect(style("D7").alignment).toMatchObject({ horizontal: "right", indent: 2 });
    // The default style: theme colour 1 of the file's theme, no fill, no borders.
    expect(workbook.getStyle(0)).toEqual({
      font: { name: "Calibri", sizePt: 11, bold: false, italic: false, underline: false, strike: false, color: "#000000" },
      fill: { color: null },
      border: {
        top: { style: "none", color: null },
        right: { style: "none", color: null },
        bottom: { style: "none", color: null },
        left: { style: "none", color: null },
      },
      alignment: { horizontal: "general", vertical: "bottom", wrapText: false, indent: 0 },
      numberFormat: "General",
    });
    // An id outside the table is the default style.
    expect(workbook.getStyle(9999)).toEqual(workbook.getStyle(0));
  });

  it("reports sizes, merges and panes", async () => {
    const workbook = await openXlsx(loadFixture("formats.xlsx"));
    const sheet = workbook.getSheet(sheetId(workbook, "Formats"));
    expect(sheet.rows).toEqual([{ index: 0, heightPt: 28, hidden: false }]);
    expect(sheet.columns[0]).toEqual({ index: 0, width: 26, hidden: false });
    expect(sheet.defaultRowHeightPt).toBe(15);
    expect(sheet.defaultColumnWidth).toBe(8.43);
    expect(sheet.frozen).toEqual({ rows: 2, cols: 1 });
    expect(sheet.mergedRanges).toEqual([
      { start: { row: 2, col: 4 }, end: { row: 4, col: 5 } },
      { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
    ]);
  });
});

describe("multi-sheet.xlsx and model.xlsx values", () => {
  it("reads across sheets, quoted names and the hidden sheet", async () => {
    const workbook = await openXlsx(loadFixture("multi-sheet.xlsx"));
    expect(workbook.listSheets().map((sheet) => sheet.state)).toEqual(["visible", "visible", "visible", "visible", "hidden"]);
    expect(at(workbook, "Summary", "B4")).toMatchObject({ value: 915, formula: "SUM('Q1 Sales'!B2:B5,'Q2 Sales'!B2:B5)" });
    expect(at(workbook, "Summary", "B5")).toMatchObject({ value: 0.05156950672645744, display: "5.2%" });
    expect(at(workbook, "Summary", "B7")).toMatchObject({ value: "Figures checked by the regional leads.", formula: "'O''Brien Notes'!A1" });
    expect(valueAt(workbook, "o'brien notes", "A1")).toBe("Figures checked by the regional leads.");
    expect(workbook.getSheetByName("HIDDEN LOOKUP")?.state).toBe("hidden");
    expect(workbook.getSheetByName("Nope")).toBeNull();
    // Sheet ids come from the file and are stable across reopen.
    expect(workbook.listSheets().map((sheet) => sheet.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("reads the financial model", async () => {
    const workbook = await openXlsx(loadFixture("model.xlsx"));
    expect(at(workbook, "Projection", "B3")).toMatchObject({ value: 46388, display: "Jan 2027" });
    expect(at(workbook, "Projection", "C4")).toMatchObject({ value: 51500, formula: "B4*(1+Assumptions!$B$3)", display: "51,500" });
    expect(at(workbook, "Projection", "N4")).toMatchObject({ value: 709601.478076965, formula: "SUM(B4:M4)", display: "709,601" });
    expect(at(workbook, "Summary", "B2")).toMatchObject({ value: 725000, formula: null, display: "725,000" });
    expect(at(workbook, "Summary", "B4")).toMatchObject({ formula: "B3/Projection!N4", display: "22.2%" });
    expect(workbook.getSheet(sheetId(workbook, "Projection")).frozen).toEqual({ rows: 3, cols: 1 });
  });
});
