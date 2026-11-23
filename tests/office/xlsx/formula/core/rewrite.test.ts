import { describe, expect, it } from "vitest";
import {
  parseFormula,
  rewriteFormulaText,
  rewriteReferences,
  serializeFormula,
  shiftFormulaText,
  shiftReferences,
  type ReferenceChange,
} from "../../../../../packages/office/src/xlsx/formula/parser/index.js";

const rewrite = (text: string, change: ReferenceChange, sheet = "Sheet1") => rewriteFormulaText(text, change, sheet);

describe("copy and fill: shiftReferences", () => {
  it.each([
    ["A1", 2, 1, "B3"],
    ["$A1", 2, 1, "$A3"],
    ["A$1", 2, 1, "B$1"],
    ["$A$1", 2, 1, "$A$1"],
    ["A1:B2", 1, 1, "B2:C3"],
    ["$A$1:B2", 1, 1, "$A$1:C3"],
    ["SUM(A1:A3)*B$1+Sheet2!C3", 3, 0, "SUM(A4:A6)*B$1+Sheet2!C6"],
    ["A:A", 5, 2, "C:C"],
    ["$A:B", 0, 1, "$A:C"],
    ["2:3", 2, 5, "4:5"],
    ["$2:3", 2, 0, "$2:5"],
    ["B2", -1, -1, "A1"],
    ["A1", -1, 0, "#REF!"],
    ["A1", 0, -1, "#REF!"],
    ["SUM(A1:B2)", 0, -1, "SUM(#REF!)"],
    ["XFD1", 0, 1, "#REF!"],
    ["A1048576", 1, 0, "#REF!"],
    ["Rate*A1", 1, 0, "Rate*A2"],
    ['"A1"&A1', 1, 0, '"A1"&A2'],
    ["Jan:Mar!A1", 1, 1, "Jan:Mar!B2"],
    ["Jan:Mar!A1", -1, 0, "#REF!"],
    ["SUM((A1,B$2))", 1, 1, "SUM((B2,C$2))"],
  ])("shifts %s by (%i, %i) to %s", (text, rows, cols, expected) => {
    expect(shiftFormulaText(text, rows, cols)).toBe(expected);
  });

  it("keeps a range ordered when only one corner moves past the other", () => {
    expect(shiftFormulaText("A$5:A1", 10, 0)).toBe("A$5:A11");
    expect(shiftFormulaText("$C1:A1", 0, 5)).toBe("$C1:F1");
  });

  it("returns the same tree when nothing moves", () => {
    const ast = parseFormula("$A$1+SUM($B:$B)+3");
    expect(shiftReferences(ast, 4, 4)).toBe(ast);
    const relative = parseFormula("A1");
    expect(shiftReferences(relative, 0, 0)).toBe(relative);
  });
});

describe("insert and delete rows and columns", () => {
  it.each<[string, ReferenceChange, string]>([
    ["A1+A5+A6", { kind: "insertRows", sheet: "Sheet1", index: 4, count: 2 }, "A1+A7+A8"],
    ["$A$5", { kind: "insertRows", sheet: "Sheet1", index: 4, count: 1 }, "$A$6"],
    ["SUM(A1:A10)", { kind: "insertRows", sheet: "Sheet1", index: 4, count: 3 }, "SUM(A1:A13)"],
    ["SUM(A5:A10)", { kind: "insertRows", sheet: "Sheet1", index: 4, count: 3 }, "SUM(A8:A13)"],
    ["SUM(A1:A4)", { kind: "insertRows", sheet: "Sheet1", index: 4, count: 3 }, "SUM(A1:A4)"],
    ["SUM(A:A)+SUM(5:6)", { kind: "insertRows", sheet: "Sheet1", index: 2, count: 1 }, "SUM(A:A)+SUM(6:7)"],
    ["A1048576", { kind: "insertRows", sheet: "Sheet1", index: 0, count: 1 }, "#REF!"],
    ["A1:A1048576", { kind: "insertRows", sheet: "Sheet1", index: 5, count: 1 }, "A1:A1048576"],
    ["B1+C1", { kind: "insertColumns", sheet: "Sheet1", index: 2, count: 2 }, "B1+E1"],
    ["SUM(A1:C1)+SUM(B:C)", { kind: "insertColumns", sheet: "Sheet1", index: 1, count: 1 }, "SUM(A1:D1)+SUM(C:D)"],
    ["SUM(1:2)", { kind: "insertColumns", sheet: "Sheet1", index: 1, count: 1 }, "SUM(1:2)"],
    ["A1+A5+A6", { kind: "deleteRows", sheet: "Sheet1", index: 4, count: 1 }, "A1+#REF!+A5"],
    ["SUM(A1:A10)", { kind: "deleteRows", sheet: "Sheet1", index: 2, count: 3 }, "SUM(A1:A7)"],
    ["SUM(A3:A10)", { kind: "deleteRows", sheet: "Sheet1", index: 0, count: 5 }, "SUM(A1:A5)"],
    ["SUM(A3:A10)", { kind: "deleteRows", sheet: "Sheet1", index: 7, count: 10 }, "SUM(A3:A7)"],
    ["SUM(A3:A5)", { kind: "deleteRows", sheet: "Sheet1", index: 2, count: 3 }, "SUM(#REF!)"],
    ["SUM(A3:A5)", { kind: "deleteRows", sheet: "Sheet1", index: 0, count: 10 }, "SUM(#REF!)"],
    ["SUM(A:A)+SUM(5:6)", { kind: "deleteRows", sheet: "Sheet1", index: 0, count: 2 }, "SUM(A:A)+SUM(3:4)"],
    ["SUM(5:6)", { kind: "deleteRows", sheet: "Sheet1", index: 4, count: 2 }, "SUM(#REF!)"],
    ["A1+B1+C1", { kind: "deleteColumns", sheet: "Sheet1", index: 1, count: 1 }, "A1+#REF!+B1"],
    ["SUM(A1:D1)+SUM(B:D)", { kind: "deleteColumns", sheet: "Sheet1", index: 1, count: 2 }, "SUM(A1:B1)+SUM(B:B)"],
  ])("%s after %j is %s", (text, change, expected) => {
    expect(rewrite(text, change)).toBe(expected);
  });

  it("touches only references to the changed sheet", () => {
    const change: ReferenceChange = { kind: "insertRows", sheet: "Data", index: 0, count: 1 };
    expect(rewrite("A1+Data!A1+'data'!B2+Other!A1", change)).toBe("A1+Data!A2+data!B3+Other!A1");
    expect(rewrite("A1+Data!A1", change, "DATA")).toBe("A2+Data!A2");
  });

  it("returns the same tree when no reference is affected", () => {
    const ast = parseFormula("A1+SUM(B1:B3)");
    expect(rewriteReferences(ast, { kind: "insertRows", sheet: "Sheet1", index: 10, count: 1 }, "Sheet1")).toBe(ast);
    expect(rewriteReferences(ast, { kind: "deleteRows", sheet: "Other", index: 0, count: 1 }, "Sheet1")).toBe(ast);
  });

  it("works on contract trees without the text helpers", () => {
    const ast = parseFormula("SUM(A1:A3)+B5");
    const out = rewriteReferences(ast, { kind: "insertRows", sheet: "S", index: 1, count: 2 }, "S");
    expect(serializeFormula(out)).toBe("SUM(A1:A5)+B7");
  });
});

describe("moving rows and columns", () => {
  it.each<[string, ReferenceChange, string]>([
    ["A3+A4+A5+A6+A7+A8", { kind: "moveRows", sheet: "Sheet1", from: 2, count: 2, to: 5 }, "A6+A7+A3+A4+A5+A8"],
    ["A6+A2", { kind: "moveRows", sheet: "Sheet1", from: 5, count: 1, to: 0 }, "A1+A3"],
    ["SUM(A3:A4)", { kind: "moveRows", sheet: "Sheet1", from: 2, count: 2, to: 5 }, "SUM(A6:A7)"],
    ["SUM(A1:A3)", { kind: "moveRows", sheet: "Sheet1", from: 0, count: 1, to: 9 }, "SUM(A2:A10)"],
    ["B1+C1+D1", { kind: "moveColumns", sheet: "Sheet1", from: 1, count: 1, to: 3 }, "D1+B1+C1"],
    ["SUM(B:B)", { kind: "moveColumns", sheet: "Sheet1", from: 1, count: 1, to: 3 }, "SUM(D:D)"],
  ])("%s after %j is %s", (text, change, expected) => {
    expect(rewrite(text, change)).toBe(expected);
  });
});

describe("moving cells", () => {
  const from = { sheet: "Sheet1", startRow: 0, startCol: 0, endRow: 1, endCol: 1 };

  it("follows references into the moved rectangle", () => {
    const change: ReferenceChange = { kind: "moveCells", from, toRow: 9, toCol: 3 };
    expect(rewrite("A1+B2+SUM(A1:B2)+C1+SUM(A1:C3)", change)).toBe("D10+E11+SUM(D10:E11)+C1+SUM(A1:C3)");
    expect(rewrite("$A$1", change)).toBe("$D$10");
  });

  it("turns references to overwritten cells into #REF!", () => {
    const change: ReferenceChange = { kind: "moveCells", from, toRow: 9, toCol: 3 };
    expect(rewrite("D10+SUM(D10:E11)+F10+SUM(D10:F12)", change)).toBe("#REF!+SUM(#REF!)+F10+SUM(D10:F12)");
  });

  it("qualifies references when the cells move to another sheet", () => {
    const change: ReferenceChange = { kind: "moveCells", from, toRow: 0, toCol: 0, toSheet: "Archive" };
    expect(rewrite("A1+C1", change)).toBe("Archive!A1+C1");
    expect(rewrite("Sheet1!A1+Sheet1!C1", change, "Other")).toBe("Archive!A1+Sheet1!C1");
    expect(rewrite("A1", change, "Archive")).toBe("#REF!");
  });

  it("keeps a moved formula pointing at the cells it pointed at", () => {
    const change: ReferenceChange = { kind: "moveCells", from, toRow: 0, toCol: 0, toSheet: "Archive" };
    expect(rewriteFormulaText("A1+C1", change, "Sheet1", "Archive")).toBe("A1+Sheet1!C1");
  });

  it("gives #REF! when the destination is off the sheet", () => {
    expect(rewrite("B2", { kind: "moveCells", from, toRow: 1_048_575, toCol: 0 })).toBe("#REF!");
  });
});

describe("renaming and removing sheets", () => {
  it("renames sheet prefixes without regard to case", () => {
    const change: ReferenceChange = { kind: "renameSheet", from: "Data", to: "Raw data" };
    expect(rewrite("A1+data!A1+SUM('DATA'!A:A)+Data!Rate+Other!A1", change)).toBe(
      "A1+'Raw data'!A1+SUM('Raw data'!A:A)+'Raw data'!Rate+Other!A1",
    );
    expect(rewrite("SUM(Data:Other!A1)", change)).toBe("SUM('Raw data:Other'!A1)");
  });

  it("turns references to a removed sheet into #REF!", () => {
    const change: ReferenceChange = { kind: "deleteSheet", sheet: "Data" };
    expect(rewrite("A1+Data!A1+SUM(data!A:A)+Data!Rate+Other!A1", change)).toBe("A1+#REF!+SUM(#REF!)+#REF!+Other!A1");
    expect(rewrite("SUM(Jan:Data!A1)+SUM(Jan:Mar!A1)", change)).toBe("SUM(#REF!)+SUM(Jan:Mar!A1)");
  });
});

describe("text helpers", () => {
  it("accept a leading = and reject text that does not parse", () => {
    expect(shiftFormulaText("=A1", 1, 0)).toBe("A2");
    expect(() => shiftFormulaText("A1+", 1, 0)).toThrowError(/offset 3/);
  });
});
