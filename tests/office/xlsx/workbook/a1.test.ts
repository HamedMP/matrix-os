import { describe, expect, it } from "vitest";
import { isOfficeError } from "../../../../packages/office/src/errors.js";
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
  quoteSheetName,
} from "../../../../packages/office/src/xlsx/workbook/a1.js";

function code(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return isOfficeError(error) ? error.code : "other";
  }
  return null;
}

describe("column labels", () => {
  it.each<[number, string]>([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [27, "AB"],
    [701, "ZZ"],
    [702, "AAA"],
    [16383, "XFD"],
  ])("column %d is %s", (index, label) => {
    expect(columnLabel(index)).toBe(label);
    expect(columnIndex(label)).toBe(index);
    expect(columnIndex(label.toLowerCase())).toBe(index);
  });

  it("rejects what is not a column", () => {
    expect(code(() => columnLabel(-1))).toBe("invalid_argument");
    expect(code(() => columnLabel(MAX_COLS))).toBe("invalid_argument");
    expect(code(() => columnLabel(1.5))).toBe("invalid_argument");
    expect(code(() => columnIndex(""))).toBe("invalid_argument");
    expect(code(() => columnIndex("XFE"))).toBe("invalid_argument");
    expect(code(() => columnIndex("A1"))).toBe("invalid_argument");
    expect(code(() => columnIndex("ABCD"))).toBe("invalid_argument");
  });
});

describe("cell addresses", () => {
  it("parses and formats", () => {
    expect(parseA1("A1")).toEqual({ row: 0, col: 0 });
    expect(parseA1("B3")).toEqual({ row: 2, col: 1 });
    expect(parseA1("$B$3")).toEqual({ row: 2, col: 1 });
    expect(parseA1("xfd1048576")).toEqual({ row: MAX_ROWS - 1, col: MAX_COLS - 1 });
    expect(formatA1({ row: 2, col: 1 })).toBe("B3");
    expect(formatA1({ row: MAX_ROWS - 1, col: MAX_COLS - 1 })).toBe("XFD1048576");
  });

  it.each(["", "A", "1", "A0", "A1048577", "XFE1", "A1:B2", "A-1", "Sheet1!A1", "A1 B2"])("rejects %j", (text) => {
    expect(code(() => parseA1(text))).toBe("invalid_argument");
  });

  it("rejects addresses outside the sheet when formatting", () => {
    expect(code(() => formatA1({ row: -1, col: 0 }))).toBe("invalid_argument");
    expect(code(() => formatA1({ row: MAX_ROWS, col: 0 }))).toBe("invalid_argument");
  });
});

describe("ranges", () => {
  it("parses cells, rectangles, whole columns and whole rows", () => {
    expect(parseA1Range("A1:C3")).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    expect(parseA1Range("B2")).toEqual({ start: { row: 1, col: 1 }, end: { row: 1, col: 1 } });
    expect(parseA1Range("$A$1:$C$3")).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    expect(parseA1Range("A:C")).toEqual({ start: { row: 0, col: 0 }, end: { row: MAX_ROWS - 1, col: 2 } });
    expect(parseA1Range("2:5")).toEqual({ start: { row: 1, col: 0 }, end: { row: 4, col: MAX_COLS - 1 } });
  });

  it("normalises the corners", () => {
    expect(parseA1Range("C3:A1")).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    expect(parseA1Range("A3:C1")).toEqual({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } });
    expect(parseA1Range("C:A")).toEqual({ start: { row: 0, col: 0 }, end: { row: MAX_ROWS - 1, col: 2 } });
  });

  it("formats", () => {
    expect(formatA1Range({ start: { row: 0, col: 0 }, end: { row: 2, col: 2 } })).toBe("A1:C3");
    expect(formatA1Range({ start: { row: 1, col: 1 }, end: { row: 1, col: 1 } })).toBe("B2");
  });

  it.each(["", "A1:", ":B2", "A:1", "A1:B", "0:3", "A1:B2:C3", "hello"])("rejects %j", (text) => {
    expect(code(() => parseA1Range(text))).toBe("invalid_argument");
  });
});

describe("sheet ranges", () => {
  it("splits the sheet from the range", () => {
    expect(parseSheetRange("Sheet1!A1:B2")).toEqual({
      sheetName: "Sheet1",
      range: { start: { row: 0, col: 0 }, end: { row: 1, col: 1 } },
    });
    expect(parseSheetRange("'My sheet'!A1").sheetName).toBe("My sheet");
    expect(parseSheetRange("'O''Brien Notes'!$A$1").sheetName).toBe("O'Brien Notes");
    expect(parseSheetRange("'a!b'!C3")).toEqual({
      sheetName: "a!b",
      range: { start: { row: 2, col: 2 }, end: { row: 2, col: 2 } },
    });
    expect(parseSheetRange("B2:C4").sheetName).toBeNull();
    expect(parseSheetRange("Data!A:A").range.end.row).toBe(MAX_ROWS - 1);
  });

  it.each(["", "Sheet1!", "!A1", "'open!A1", "''!A1", "'x'A1", "Sheet1!nope"])("rejects %j", (text) => {
    expect(code(() => parseSheetRange(text))).toBe("invalid_argument");
  });

  it("quotes sheet names only when a formula needs it", () => {
    expect(quoteSheetName("Data")).toBe("Data");
    expect(quoteSheetName("Q1_Sales.v2")).toBe("Q1_Sales.v2");
    expect(quoteSheetName("Q1 Sales")).toBe("'Q1 Sales'");
    expect(quoteSheetName("O'Brien Notes")).toBe("'O''Brien Notes'");
    expect(quoteSheetName("A1")).toBe("'A1'");
    expect(quoteSheetName("2026")).toBe("'2026'");
    expect(quoteSheetName("TRUE")).toBe("'TRUE'");
    expect(quoteSheetName("R1C1")).toBe("'R1C1'");
    expect(quoteSheetName("Données")).toBe("'Données'");
  });
});
