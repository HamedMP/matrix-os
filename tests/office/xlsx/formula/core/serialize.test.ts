import { describe, expect, it } from "vitest";
import type { FormulaAst, ReferenceNode } from "../../../../../packages/office/src/api/formula.js";
import {
  collectFunctionNames,
  collectReferences,
  columnIndex,
  columnLabel,
  mapReferences,
  parseFormula,
  parseFormulaExtended,
  quoteSheetName,
  serializeFormula,
  transformNodes,
  visitNodes,
} from "../../../../../packages/office/src/xlsx/formula/parser/index.js";

const roundTrip = (text: string) => serializeFormula(parseFormulaExtended(text));

describe("serializeFormula", () => {
  it.each([
    ["=1+2", "1+2"],
    [" 1 +  2 * 3 ", "1+2*3"],
    ["(1+2)*3", "(1+2)*3"],
    ["sum(a1:b2)", "SUM(A1:B2)"],
    ["$A$1+B$2+$C3", "$A$1+B$2+$C3"],
    ["$B$2:A1", "A1:$B$2"],
    ["A:C", "A:C"],
    ["$A:$C", "$A:$C"],
    ["2:5", "2:5"],
    ["$2:$5", "$2:$5"],
    ["Sheet2!C3", "Sheet2!C3"],
    ["'My sheet'!C3", "'My sheet'!C3"],
    ["'Sheet2'!C3", "Sheet2!C3"],
    ["'It''s'!A1:B2", "'It''s'!A1:B2"],
    ["'2024'!A1", "'2024'!A1"],
    ["'A1'!B2", "'A1'!B2"],
    ["'TRUE'!B2", "'TRUE'!B2"],
    ["'R1C1'!B2", "'R1C1'!B2"],
    ["'a-b'!A:A", "'a-b'!A:A"],
    ["Sheet1!TaxRate*2", "Sheet1!TaxRate*2"],
    ['"say ""hi"""&"!"', '"say ""hi"""&"!"'],
    ["true", "TRUE"],
    ["#n/a", "#N/A"],
    ["IF(A1,,2)", "IF(A1,,2)"],
    ["IF(A1,1,)", "IF(A1,1,)"],
    ["PI()", "PI()"],
    ["{1,2;3,4}", "{1,2;3,4}"],
    ['{-1,"a",TRUE,#N/A}', '{-1,"a",TRUE,#N/A}'],
    ["-2^2", "-2^2"],
    ["2^-2", "2^-2"],
    ["-(2^2)", "-(2^2)"],
    ["50%", "50%"],
    ["-A1%", "-A1%"],
    ["1.5E-10", "1.5E-10"],
    ["1E+21", "1E+21"],
    ["0.1", "0.1"],
    ["_xlfn.XLOOKUP(1,A:A,B:B)", "XLOOKUP(1,A:A,B:B)"],
    ["A1<>B1", "A1<>B1"],
    ["A1:C3 B2:D5", "A1:C3 B2:D5"],
    ["SUM((A1:A3,C1:C3))", "SUM((A1:A3,C1:C3))"],
    ["A1:A3,C1:C3", "A1:A3,C1:C3"],
    ["A1:INDEX(B:B,3)", "A1:INDEX(B:B,3)"],
    ["Jan:Mar!B2", "Jan:Mar!B2"],
    ["SUM('Q 1:Q 4'!A1:B2)", "SUM('Q 1:Q 4'!A1:B2)"],
  ])("writes %s as %s", (text, expected) => {
    expect(roundTrip(text)).toBe(expected);
  });

  it.each([
    "1+2*3-4/5^6",
    "((1+2))*-3%",
    "IF(AND(A1>0,B1<>\"\"),SUM($A$1:A10)/COUNT(A:A),\"n/a\")",
    "'My sheet'!$A$1:$B$2*Sheet2!C3&\"x\"",
    "{1,2;3,4}*{1;2}",
    "IFERROR(VLOOKUP(A1,'Other sheet'!A:C,3,FALSE),)",
    "-(-(1))",
    "2^3^2",
    "1<2=TRUE",
    "SUM((A1:A3,C1:C3) A1:C1)",
    "SUM(Jan:Dec!$B$2,Totals!1:1)",
    "1e-7+1.5E+30",
  ])("round-trips %s to the same tree", (text) => {
    const first = parseFormulaExtended(text);
    const written = serializeFormula(first);
    expect(parseFormulaExtended(written)).toEqual(first);
    expect(serializeFormula(parseFormulaExtended(written))).toBe(written);
  });

  it("adds the parentheses a tree built by hand needs", () => {
    const one: FormulaAst = { type: "number", value: 1 };
    const two: FormulaAst = { type: "number", value: 2 };
    const sum: FormulaAst = { type: "binary", op: "+", left: one, right: two };
    expect(serializeFormula({ type: "binary", op: "*", left: sum, right: two })).toBe("(1+2)*2");
    expect(serializeFormula({ type: "binary", op: "-", left: one, right: sum })).toBe("1-(1+2)");
    expect(serializeFormula({ type: "binary", op: "-", left: sum, right: one })).toBe("1+2-1");
    expect(serializeFormula({ type: "binary", op: "^", left: two, right: { type: "binary", op: "^", left: two, right: two } })).toBe(
      "2^(2^2)",
    );
    expect(serializeFormula({ type: "unary", op: "-", operand: sum })).toBe("-(1+2)");
    expect(serializeFormula({ type: "unary", op: "%", operand: sum })).toBe("(1+2)%");
    expect(serializeFormula({ type: "unary", op: "-", operand: { type: "unary", op: "%", operand: two } })).toBe("-(2%)");
    expect(serializeFormula({ type: "binary", op: "*", left: { type: "number", value: -2 }, right: two })).toBe("-2*2");
    const a1 = parseFormula("A1");
    const b1 = parseFormula("B1");
    expect(serializeFormula({ type: "call", name: "sum", args: [{ type: "refop", op: ",", left: a1, right: b1 }] })).toBe(
      "SUM((A1,B1))",
    );
  });

  it("can write the prefix a file needs for newer functions", () => {
    const ast = parseFormula("IFERROR(XLOOKUP(A1,B:B,C:C),CONCAT(SUM(1),FILTER(A:A,B:B)))");
    expect(serializeFormula(ast)).toBe("IFERROR(XLOOKUP(A1,B:B,C:C),CONCAT(SUM(1),FILTER(A:A,B:B)))");
    expect(serializeFormula(ast, { filePrefixes: true })).toBe(
      "IFERROR(_xlfn.XLOOKUP(A1,B:B,C:C),_xlfn.CONCAT(SUM(1),_xlfn._xlws.FILTER(A:A,B:B)))",
    );
    expect(parseFormula(serializeFormula(ast, { filePrefixes: true }))).toEqual(ast);
  });
});

describe("A1 helpers", () => {
  it("converts column letters both ways", () => {
    expect([0, 25, 26, 27, 701, 702, 16383].map(columnLabel)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA", "XFD"]);
    expect(["A", "z", "AA", "XFD", "XFE", "", "A1", "ABCD"].map(columnIndex)).toEqual([0, 25, 26, 16383, -1, -1, -1, -1]);
  });

  it("quotes sheet names only when needed", () => {
    expect(quoteSheetName("Sheet1")).toBe("Sheet1");
    expect(quoteSheetName("Übersicht_2")).toBe("Übersicht_2");
    expect(quoteSheetName("My sheet")).toBe("'My sheet'");
    expect(quoteSheetName("O'Brien")).toBe("'O''Brien'");
    expect(quoteSheetName("2024")).toBe("'2024'");
    expect(quoteSheetName("AB12")).toBe("'AB12'");
  });
});

describe("walking a tree", () => {
  it("collects references and names in source order", () => {
    const refs = collectReferences(parseFormula("A1+SUM(Sheet2!B1:B3,Rate)*IF(C1,$D$1,{1,2})-(E:E)"));
    expect(refs.map((ref) => serializeFormula(ref))).toEqual(["A1", "Sheet2!B1:B3", "Rate", "C1", "$D$1", "E:E"]);
    expect(collectReferences(parseFormula("1+2"))).toEqual([]);
  });

  it("collects the functions a formula calls", () => {
    expect(collectFunctionNames(parseFormula("sum(1,Sum(2),NOW())+RAND()"))).toEqual(["SUM", "NOW", "RAND"]);
  });

  it("visits parents before children", () => {
    const seen: string[] = [];
    visitNodes(parseFormula("-(A1+2)"), (node) => seen.push(node.type));
    expect(seen).toEqual(["unary", "paren", "binary", "cell", "number"]);
  });

  it("maps references and shares what did not change", () => {
    const ast = parseFormula("A1+SUM(B1:B3,5)*C1");
    const same = mapReferences(ast, (node) => node);
    expect(same).toBe(ast);
    const mapped = mapReferences(ast, (node: ReferenceNode) =>
      node.type === "cell" && node.col === 2 ? { type: "error", code: "#REF!" } : node,
    );
    expect(serializeFormula(mapped)).toBe("A1+SUM(B1:B3,5)*#REF!");
    expect(serializeFormula(ast)).toBe("A1+SUM(B1:B3,5)*C1");
    expect((mapped as { left: unknown }).left).toBe((ast as { left: unknown }).left);
  });

  it("replaces nodes without walking into the replacement", () => {
    const ast = parseFormula("F(G(1),{1,2})");
    const out = transformNodes(ast, (node) => (node.type === "number" ? { type: "call", name: "N", args: [node] } : null));
    expect(serializeFormula(out)).toBe("F(G(N(1)),{N(1),N(2)})");
  });
});
