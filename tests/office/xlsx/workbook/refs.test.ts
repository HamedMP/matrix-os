import { describe, expect, it } from "vitest";
import {
  type StructuralOp,
  moveSpan,
  rewriteForRemoval,
  rewriteForRename,
  rewriteForStructure,
  shiftRelativeRefs,
} from "../../../../packages/office/src/xlsx/workbook/refs-rewrite.js";
import { scanRefs } from "../../../../packages/office/src/xlsx/workbook/refs-scan.js";

const refs = (text: string) => scanRefs(text).map((ref) => text.slice(ref.start, ref.end));

describe("finding references in formula text", () => {
  it.each<[string, string[]]>([
    ["A1", ["A1"]],
    ["A1+B2*3", ["A1", "B2"]],
    ["SUM(A1:B2)", ["A1:B2"]],
    ["SUM($A$1:B$2,C3)", ["$A$1:B$2", "C3"]],
    ["SUM(A:A)+SUM(2:5)", ["A:A", "2:5"]],
    ["SUM($A:$C,$2:$5)", ["$A:$C", "$2:$5"]],
    ["Sheet2!A1", ["Sheet2!A1"]],
    ["'My sheet'!A1:B2+1", ["'My sheet'!A1:B2"]],
    ["'O''Brien Notes'!A1", ["'O''Brien Notes'!A1"]],
    ["Data!$E$2:$E$6", ["Data!$E$2:$E$6"]],
    ['IF(B1>100,"A1","No")', ["B1"]],
    ['"say ""A1"" please"&C3', ["C3"]],
    ["LOG10(A1)+LOG(B2)", ["A1", "B2"]],
    ["TaxRate*B7", ["B7"]],
    ["Rate2025*B7", ["B7"]],
    ["_xlfn.XLOOKUP(A1,B:B,C:C)", ["A1", "B:B", "C:C"]],
    ["1.5E+10+A1", ["A1"]],
    ["2*3", []],
    ["TRUE", []],
    ["Table1[Amount]+A1", ["A1"]],
    ["[1]Sheet1!A1+B2", ["B2"]],
    ["'[Book.xlsx]Sheet1'!A1+B2", ["B2"]],
    ["Jan:Mar!A1+B2", ["B2"]],
    ["#REF!+A1", ["A1"]],
    ["IF(ISNA(A1),#N/A,B1)", ["A1", "B1"]],
    ["Sheet1!Total+A1", ["Sheet1!Total", "A1"]],
    ["A1B2+XFE1+A1048577", []],
    ["a1+b2", ["a1", "b2"]],
  ])("%s", (formula, expected) => {
    expect(refs(formula)).toEqual(expected);
  });

  it("reports sheet, kind and absolute flags", () => {
    const [ref] = scanRefs("'Q1 Sales'!$B2:C$5");
    expect(ref).toMatchObject({
      sheet: "Q1 Sales",
      kind: "range",
      a: { row: 1, col: 1, rowAbs: false, colAbs: true },
      b: { row: 4, col: 2, rowAbs: true, colAbs: false },
    });
    expect(scanRefs("A:C")[0]).toMatchObject({ kind: "cols", sheet: null });
    expect(scanRefs("2:5")[0]).toMatchObject({ kind: "rows", a: { row: 1 }, b: { row: 4 } });
  });

  it("copes with unterminated literals", () => {
    expect(refs('"open+A1')).toEqual([]);
    expect(refs("'open!A1")).toEqual([]);
    expect(refs("Table1[open+A1")).toEqual([]);
  });
});

const insertRows = (index: number, count: number): StructuralOp => ({ axis: "row", index, count });
const deleteRows = (index: number, count: number): StructuralOp => ({ axis: "row", index, count: -count });
const insertCols = (index: number, count: number): StructuralOp => ({ axis: "col", index, count });
const deleteCols = (index: number, count: number): StructuralOp => ({ axis: "col", index, count: -count });

describe("rewriting for inserted and deleted rows and columns", () => {
  // Formulas on the edited sheet, named "Data".
  it.each<[string, StructuralOp, string]>([
    ["A1+A5", insertRows(2, 2), "A1+A7"],
    ["$A$5", insertRows(2, 2), "$A$7"],
    ["SUM(A1:A10)", insertRows(4, 3), "SUM(A1:A13)"],
    ["SUM(A1:A10)", insertRows(10, 1), "SUM(A1:A10)"],
    ["SUM(A1:A10)", insertRows(0, 1), "SUM(A2:A11)"],
    ["SUM(A:A)", insertRows(3, 1), "SUM(A:A)"],
    ["SUM(2:5)", insertRows(3, 2), "SUM(2:7)"],
    ["Data!B7*2", insertRows(0, 1), "Data!B8*2"],
    ["Other!B7*2", insertRows(0, 1), "Other!B7*2"],
    ["A1048576", insertRows(0, 1), "#REF!"],
    ["A5", deleteRows(4, 1), "#REF!"],
    ["A5+A6", deleteRows(4, 1), "#REF!+A5"],
    ["Data!A5", deleteRows(4, 1), "#REF!"],
    ["SUM(A1:A10)", deleteRows(4, 2), "SUM(A1:A8)"],
    ["SUM(A1:A10)", deleteRows(0, 2), "SUM(A1:A8)"],
    ["SUM(A5:A10)", deleteRows(2, 5), "SUM(A3:A5)"],
    ["SUM(A5:A10)", deleteRows(8, 5), "SUM(A5:A8)"],
    ["SUM(A5:A10)", deleteRows(4, 6), "SUM(#REF!)"],
    ["SUM(A10:A5)", deleteRows(4, 2), "SUM(A8:A5)"],
    ["SUM(3:4)", deleteRows(2, 2), "SUM(#REF!)"],
    ["B2", insertCols(1, 2), "D2"],
    ["SUM(A1:C1)", insertCols(1, 1), "SUM(A1:D1)"],
    ["SUM(A:C)", insertCols(1, 1), "SUM(A:D)"],
    ["SUM(2:5)", insertCols(1, 1), "SUM(2:5)"],
    ["C1", deleteCols(1, 1), "B1"],
    ["B1", deleteCols(1, 1), "#REF!"],
    ["SUM(A1:D1)", deleteCols(1, 2), "SUM(A1:B1)"],
    ["SUM(B:C)", deleteCols(1, 2), "SUM(#REF!)"],
    ["XFD1", insertCols(0, 1), "#REF!"],
    ['IF(A5>0,"A5",_xlfn.XLOOKUP(A5,A:A,B:B))', insertRows(0, 1), 'IF(A6>0,"A5",_xlfn.XLOOKUP(A6,A:A,B:B))'],
    [" A5 +  A6 ", insertRows(0, 1), " A6 +  A7 "],
  ])("%s after %j is %s", (formula, op, expected) => {
    expect(rewriteForStructure(formula, true, "data", op)).toBe(expected);
  });

  it("touches only qualified references when the formula is on another sheet", () => {
    expect(rewriteForStructure("A5+Data!A5+'DATA'!A6", false, "data", insertRows(0, 1))).toBe("A5+Data!A6+'DATA'!A7");
    expect(rewriteForStructure("A5+Data!A5", false, "data", deleteRows(4, 1))).toBe("A5+#REF!");
  });

  it("moves spans", () => {
    expect(moveSpan(2, 5, insertRows(3, 2))).toEqual({ low: 2, high: 7 });
    expect(moveSpan(2, 5, deleteRows(0, 10))).toBeNull();
    expect(moveSpan(2, 5, deleteRows(3, 1))).toEqual({ low: 2, high: 4 });
    expect(moveSpan(1048570, 1048575, insertRows(0, 10))).toBeNull();
    expect(moveSpan(1048560, 1048570, insertRows(0, 10))).toEqual({ low: 1048570, high: 1048575 });
  });
});

describe("rewriting for sheets", () => {
  it("renames", () => {
    expect(rewriteForRename("Data!A1+data!B2+Other!C3+D4", "data", "Numbers")).toBe("Numbers!A1+Numbers!B2+Other!C3+D4");
    expect(rewriteForRename("'Q1 Sales'!B6", "q1 sales", "First Quarter")).toBe("'First Quarter'!B6");
    expect(rewriteForRename("'Q1 Sales'!B6", "q1 sales", "Q1")).toBe("'Q1'!B6");
    expect(rewriteForRename("SUM('Q1 Sales'!B2:B5,'Q2 Sales'!B2:B5)", "q2 sales", "It's")).toBe(
      "SUM('Q1 Sales'!B2:B5,'It''s'!B2:B5)",
    );
    expect(rewriteForRename("Data!Total*2", "data", "New")).toBe("New!Total*2");
    expect(rewriteForRename('"Data!A1"', "data", "New")).toBe('"Data!A1"');
  });

  it("turns references to a removed sheet into errors", () => {
    expect(rewriteForRemoval("Data!A1+Other!C3", "data")).toBe("#REF!+Other!C3");
    expect(rewriteForRemoval("SUM('Q1 Sales'!B2:B5)", "q1 sales")).toBe("SUM(#REF!)");
    expect(rewriteForRemoval("A1+1", "data")).toBe("A1+1");
  });
});

describe("copying a shared formula", () => {
  it.each<[string, number, number, string]>([
    ["A2*2", 1, 0, "A3*2"],
    ["A2*$B$1", 3, 0, "A5*$B$1"],
    ["$A2+A$2", 1, 1, "$A3+B$2"],
    ["SUM(A1:B2)", 2, 1, "SUM(B3:C4)"],
    ["SUM(A:A)+SUM(1:1)", 2, 1, "SUM(B:B)+SUM(3:3)"],
    ["Sheet2!A1+1", 1, 1, "Sheet2!B2+1"],
    ["A1", -1, 0, "#REF!"],
    ["A1", 0, 0, "A1"],
    ['"A1"&A1', 1, 0, '"A1"&A2'],
  ])("%s moved %d down and %d right is %s", (formula, rows, cols, expected) => {
    expect(shiftRelativeRefs(formula, rows, cols)).toBe(expected);
  });
});
