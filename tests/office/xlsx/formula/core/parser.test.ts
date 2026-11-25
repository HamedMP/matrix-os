import { describe, expect, it } from "vitest";
import type { FormulaAst } from "../../../../../packages/office/src/api/formula.js";
import { isOfficeError } from "../../../../../packages/office/src/errors.js";
import {
  MAX_AST_DEPTH,
  MAX_COL,
  MAX_ROW,
  isContractAst,
  parseFormula,
  parseFormulaExtended,
  type ExtendedAst,
} from "../../../../../packages/office/src/xlsx/formula/parser/index.js";

/** A compact S-expression of a tree, so that precedence tables stay readable. */
function sexp(node: ExtendedAst): string {
  switch (node.type) {
    case "number":
      return String(node.value);
    case "string":
      return JSON.stringify(node.value);
    case "boolean":
      return node.value ? "TRUE" : "FALSE";
    case "error":
      return node.code;
    case "missing":
      return "_";
    case "cell":
      return `${node.sheet === null ? "" : `${node.sheet}!`}r${node.row}c${node.col}`;
    case "range":
      return `${node.sheet === null ? "" : `${node.sheet}!`}${node.shape}[${node.start.row},${node.start.col}..${node.end.row},${node.end.col}]`;
    case "ref3d":
      return `${node.startSheet}>${node.endSheet}!${sexp(node.ref)}`;
    case "name":
      return `${node.sheet === null ? "" : `${node.sheet}!`}@${node.name}`;
    case "unary":
      return `(${node.op === "-" ? "neg" : node.op === "+" ? "pos" : "pct"} ${sexp(node.operand)})`;
    case "binary":
      return `(${node.op} ${sexp(node.left)} ${sexp(node.right)})`;
    case "refop":
      return `(${node.op === " " ? "isect" : node.op === "," ? "union" : "range"} ${sexp(node.left)} ${sexp(node.right)})`;
    case "call":
      return `${node.name}(${node.args.map(sexp).join(" ")})`;
    case "array":
      return `{${node.rows.map((row) => row.map(sexp).join(" ")).join(" | ")}}`;
    case "paren":
      return `[${sexp(node.inner)}]`;
  }
}

const tree = (text: string) => sexp(parseFormula(text));
const extended = (text: string) => sexp(parseFormulaExtended(text));

function failure(run: () => unknown): { code: string; offset: unknown } {
  try {
    run();
  } catch (error) {
    if (isOfficeError(error)) return { code: error.code, offset: error.details.offset };
    throw error;
  }
  throw new Error("expected the formula to be rejected");
}

describe("literals", () => {
  it.each([
    ["1", "1"],
    ["=1", "1"],
    [" = 1 ", "1"],
    ["1.5", "1.5"],
    [".5", "0.5"],
    ["5.", "5"],
    ["1e3", "1000"],
    ["1.5E-2", "0.015"],
    ["2E+2", "200"],
    ['"abc"', '"abc"'],
    ['""', '""'],
    ['"say ""hi"""', '"say \\"hi\\""'],
    ['"a,b;c)"', '"a,b;c)"'],
    ["TRUE", "TRUE"],
    ["false", "FALSE"],
    ["#DIV/0!", "#DIV/0!"],
    ["#N/A", "#N/A"],
    ["#name?", "#NAME?"],
    ["#REF!", "#REF!"],
    ["#VALUE!", "#VALUE!"],
    ["#NUM!", "#NUM!"],
    ["#NULL!", "#NULL!"],
  ])("parses %s", (text, expected) => {
    expect(tree(text)).toBe(expected);
  });

  it("keeps a string exactly, including line breaks", () => {
    expect(parseFormula('"a\nb"')).toEqual({ type: "string", value: "a\nb" });
  });
});

describe("operator precedence and grouping", () => {
  it.each([
    ["1+2*3", "(+ 1 (* 2 3))"],
    ["1*2+3", "(+ (* 1 2) 3)"],
    ["1-2-3", "(- (- 1 2) 3)"],
    ["8/4/2", "(/ (/ 8 4) 2)"],
    ["2^3^2", "(^ (^ 2 3) 2)"],
    ["2*3^2", "(* 2 (^ 3 2))"],
    ["-2^2", "(^ (neg 2) 2)"],
    ["2^-2", "(^ 2 (neg 2))"],
    ["--1", "(neg (neg 1))"],
    ["+1", "(pos 1)"],
    ["-A1%", "(pct (neg r0c0))"],
    ["50%", "(pct 50)"],
    ["50%%", "(pct (pct 50))"],
    ["2^50%", "(^ 2 (pct 50))"],
    ["10%*2", "(* (pct 10) 2)"],
    ['1&2+3', "(& 1 (+ 2 3))"],
    ['"a"&"b"&"c"', '(& (& "a" "b") "c")'],
    ["1+2=3", "(= (+ 1 2) 3)"],
    ['1&2=3&4', "(= (& 1 2) (& 3 4))"],
    ["1<2=TRUE", "(= (< 1 2) TRUE)"],
    ["1<>2", "(<> 1 2)"],
    ["1<=2", "(<= 1 2)"],
    ["1>=2", "(>= 1 2)"],
    ["1>2", "(> 1 2)"],
    ["(1+2)*3", "(* [(+ 1 2)] 3)"],
    ["((1))", "[[1]]"],
    ["1 + 2\n* 3", "(+ 1 (* 2 3))"],
    ["-(1+2)", "(neg [(+ 1 2)])"],
    ["1--1", "(- 1 (neg 1))"],
    ["A1:B2*2", "(* cells[0,0..1,1] 2)"],
    ["-A1:B2", "(neg cells[0,0..1,1])"],
  ])("parses %s as %s", (text, expected) => {
    expect(tree(text)).toBe(expected);
  });
});

describe("references", () => {
  it("parses cells with absolute markers", () => {
    expect(parseFormula("A1")).toEqual({ type: "cell", sheet: null, row: 0, col: 0, rowAbsolute: false, colAbsolute: false });
    expect(parseFormula("$B$2")).toEqual({ type: "cell", sheet: null, row: 1, col: 1, rowAbsolute: true, colAbsolute: true });
    expect(parseFormula("c$3")).toMatchObject({ row: 2, col: 2, rowAbsolute: true, colAbsolute: false });
    expect(parseFormula("$D4")).toMatchObject({ row: 3, col: 3, rowAbsolute: false, colAbsolute: true });
    expect(parseFormula("XFD1048576")).toMatchObject({ type: "cell", row: MAX_ROW, col: MAX_COL });
    expect(parseFormula("AA10")).toMatchObject({ row: 9, col: 26 });
  });

  it("parses ranges and orders their corners", () => {
    expect(parseFormula("A1:B2")).toEqual({
      type: "range",
      sheet: null,
      shape: "cells",
      start: { row: 0, col: 0, rowAbsolute: false, colAbsolute: false },
      end: { row: 1, col: 1, rowAbsolute: false, colAbsolute: false },
    });
    expect(parseFormula("$B$2:A1")).toMatchObject({
      start: { row: 0, col: 0, rowAbsolute: false, colAbsolute: false },
      end: { row: 1, col: 1, rowAbsolute: true, colAbsolute: true },
    });
    expect(parseFormula("B1:A$2")).toMatchObject({
      start: { row: 0, col: 0, rowAbsolute: false, colAbsolute: false },
      end: { row: 1, col: 1, rowAbsolute: true, colAbsolute: false },
    });
  });

  it("parses whole columns and whole rows", () => {
    expect(parseFormula("A:C")).toMatchObject({
      type: "range",
      shape: "columns",
      start: { row: 0, col: 0, colAbsolute: false },
      end: { row: MAX_ROW, col: 2, colAbsolute: false },
    });
    expect(parseFormula("$C:$A")).toMatchObject({ shape: "columns", start: { col: 0, colAbsolute: true }, end: { col: 2 } });
    expect(parseFormula("2:5")).toMatchObject({
      type: "range",
      shape: "rows",
      start: { row: 1, col: 0, rowAbsolute: false },
      end: { row: 4, col: MAX_COL, rowAbsolute: false },
    });
    expect(parseFormula("$3:$3")).toMatchObject({ shape: "rows", start: { row: 2, rowAbsolute: true }, end: { row: 2 } });
    expect(tree("SUM(A:A,1:1)")).toBe(`SUM(columns[0,0..${MAX_ROW},0] rows[0,0..0,${MAX_COL}])`);
  });

  it("parses sheet names, quoted or not", () => {
    expect(parseFormula("Sheet2!C3")).toMatchObject({ type: "cell", sheet: "Sheet2", row: 2, col: 2 });
    expect(parseFormula("'My sheet'!$C$3")).toMatchObject({ sheet: "My sheet", rowAbsolute: true });
    expect(parseFormula("'It''s'!A1")).toMatchObject({ sheet: "It's" });
    expect(parseFormula("'2024'!A1")).toMatchObject({ sheet: "2024" });
    expect(parseFormula("Sheet2!A1:B2")).toMatchObject({ type: "range", sheet: "Sheet2", shape: "cells" });
    expect(parseFormula("Sheet2!A1:Sheet2!B2")).toMatchObject({ type: "range", sheet: "Sheet2" });
    expect(parseFormula("'Data 1'!A:B")).toMatchObject({ type: "range", sheet: "Data 1", shape: "columns" });
    expect(parseFormula("Data!1:2")).toMatchObject({ type: "range", sheet: "Data", shape: "rows" });
    expect(parseFormula("Übersicht!A1")).toMatchObject({ sheet: "Übersicht" });
    expect(parseFormula("Sheet1!#REF!")).toEqual({ type: "error", code: "#REF!" });
  });

  it("tells cells from names and functions", () => {
    expect(tree("TaxRate")).toBe("@TaxRate");
    expect(tree("Sheet1!TaxRate")).toBe("Sheet1!@TaxRate");
    expect(tree("_total.2024")).toBe("@_total.2024");
    expect(tree("A1B")).toBe("@A1B");
    expect(tree("ABCD1")).toBe("@ABCD1");
    expect(tree("XFE1")).toBe("@XFE1");
    expect(tree("A1048577")).toBe("@A1048577");
    expect(tree("LOG10(100)")).toBe("LOG10(100)");
    expect(tree("LOG10")).toBe("r9c8508");
    expect(tree("TRUE()")).toBe("TRUE()");
    expect(tree("A1+Rate*2")).toBe("(+ r0c0 (* @Rate 2))");
  });

  it("parses a reference across sheets only in the extended grammar", () => {
    expect(extended("Jan:Mar!B2")).toBe("Jan>Mar!r1c1");
    expect(extended("SUM('Q 1:Q 4'!A1:B2)")).toBe("SUM(Q 1>Q 4!cells[0,0..1,1])");
    expect(extended("Jan:Mar!A:A")).toBe(`Jan>Mar!columns[0,0..${MAX_ROW},0]`);
    expect(failure(() => parseFormula("SUM(Jan:Mar!B2)"))).toEqual({ code: "formula_error", offset: 4 });
  });
});

describe("function calls", () => {
  it.each([
    ["SUM(1,2)", "SUM(1 2)"],
    ["sum(A1:A3)", "SUM(cells[0,0..2,0])"],
    ["PI()", "PI()"],
    ["IF(A1,,2)", "IF(r0c0 _ 2)"],
    ["IF(A1,1,)", "IF(r0c0 1 _)"],
    ["F(,)", "F(_ _)"],
    ["F(,,)", "F(_ _ _)"],
    ["IF(A1>0,SUM(B1:B3)*2,\"none\")", 'IF((> r0c0 0) (* SUM(cells[0,1..2,1]) 2) "none")'],
    ["_xlfn.XLOOKUP(1,A:A,B:B)", `XLOOKUP(1 columns[0,0..${MAX_ROW},0] columns[0,1..${MAX_ROW},1])`],
    ["_xlfn._xlws.FILTER(A1:A3,B1:B3)", "FILTER(cells[0,0..2,0] cells[0,1..2,1])"],
    ["ERROR.TYPE(A1)", "ERROR.TYPE(r0c0)"],
    ["SUM( 1 , 2 )", "SUM(1 2)"],
    ["-SUM(1)%", "(pct (neg SUM(1)))"],
  ])("parses %s", (text, expected) => {
    expect(tree(text)).toBe(expected);
  });
});

describe("array constants", () => {
  it.each([
    ["{1,2;3,4}", "{1 2 | 3 4}"],
    ['{1,"a",TRUE,#N/A}', '{1 "a" TRUE #N/A}'],
    ["{-1,+2}", "{-1 2}"],
    ["{1;2;3}", "{1 | 2 | 3}"],
    ["SUM({1,2}*2)", "SUM((* {1 2} 2))"],
  ])("parses %s", (text, expected) => {
    expect(tree(text)).toBe(expected);
  });
});

describe("reference operators (extended grammar)", () => {
  it.each([
    ["A1:C3 B2:D5", "(isect cells[0,0..2,2] cells[1,1..4,3])"],
    ["SUM(A1:C3 B2:D5)", "SUM((isect cells[0,0..2,2] cells[1,1..4,3]))"],
    ["SUM((A1:A3,C1:C3))", "SUM([(union cells[0,0..2,0] cells[0,2..2,2])])"],
    ["(A1,B1,C1)", "[(union (union r0c0 r0c1) r0c2)]"],
    ["A1:A3,C1:C3", "(union cells[0,0..2,0] cells[0,2..2,2])"],
    ["A1:INDEX(B:B,3)", `(range r0c0 INDEX(columns[0,1..${MAX_ROW},1] 3))`],
    ["A1:B2:C3", "(range cells[0,0..1,1] r2c2)"],
    ["First:Last", "(range @First @Last)"],
    ["(A1:B2 B1:C2,D1)", "[(union (isect cells[0,0..1,1] cells[0,1..1,2]) r0c3)]"],
    ["Sales North", "(isect @Sales @North)"],
    ["-A1 B1", "(neg (isect r0c0 r0c1))"],
    ["SUM(A1 , B1)", "SUM(r0c0 r0c1)"],
  ])("parses %s", (text, expected) => {
    expect(extended(text)).toBe(expected);
  });

  it("marks trees beyond the contract grammar", () => {
    expect(isContractAst(parseFormulaExtended("SUM(A1:B2)+1"))).toBe(true);
    expect(isContractAst(parseFormulaExtended("SUM((A1,B2))"))).toBe(false);
    expect(isContractAst(parseFormulaExtended("IF(1,{1,2},Jan:Mar!A1)"))).toBe(false);
  });

  it.each([
    ["A1:C3 B2:D5", 6],
    ["SUM((A1:A3,C1:C3))", 10],
    ["A1:INDEX(B:B,3)", 2],
    ["A1:B2:C3", 5],
  ])("rejects %s in the contract grammar", (text, offset) => {
    expect(failure(() => parseFormula(text))).toEqual({ code: "formula_error", offset });
  });
});

describe("syntax errors carry the offset", () => {
  it.each([
    ["", 0],
    ["=", 1],
    ["   ", 3],
    ["1+", 2],
    ["=1+", 3],
    ["1 2", 2],
    ["(1+2", 4],
    ["1+2)", 3],
    ["SUM(1,2", 7],
    ["SUM(1 2)", 6],
    ['"abc', 0],
    ["1+\"abc", 2],
    ["#BAD!", 0],
    ["1 # 2", 2],
    ["A1:5", 2],
    ["1:A1", 1],
    ["5:B", 1],
    ["{1,2;3}", 6],
    ["{1,A1}", 3],
    ["{}", 1],
    ["{1,2", 0],
    ["1 @ 2", 2],
    ["'Sheet 1'A1", 9],
    ["'Sheet 1!A1", 0],
    ["Sheet1!", 7],
    ["Sheet1!SUM(1)", 0],
    ["[Book1.xlsx]Sheet1!A1", 0],
    ["'[Book1.xlsx]Sheet1'!A1", 0],
    ["Table1[Column]", 6],
    ["A1:Sheet2!B2", 2],
    ["Sheet1!A1:Sheet2!B2", 9],
    ["1.2.3", 3],
    ["$", 0],
    ["1e999", 0],
    ["*2", 0],
    ["1,2", 1],
    ["(1,2)", 2],
    ["1 (2)", 2],
    ["A1 (1+2)", 3],
  ])("rejects %j at offset %i", (text, offset) => {
    expect(failure(() => parseFormula(text))).toEqual({ code: "formula_error", offset });
  });

  it("rejects the same errors in the extended grammar", () => {
    expect(failure(() => parseFormulaExtended("(1,2)"))).toEqual({ code: "formula_error", offset: 2 });
    expect(failure(() => parseFormulaExtended("A1 (1+2)"))).toEqual({ code: "formula_error", offset: 3 });
    expect(failure(() => parseFormulaExtended("Jan:Mar!Name"))).toEqual({ code: "formula_error", offset: 0 });
  });
});

describe("limits", () => {
  it("rejects a formula longer than 8192 characters", () => {
    expect(failure(() => parseFormula(`"${"x".repeat(8191)}"`)).code).toBe("limit_exceeded");
    expect(parseFormula(`"${"x".repeat(8190)}"`)).toMatchObject({ type: "string" });
  });

  it("rejects nesting beyond the depth limit without overflowing the stack", () => {
    expect(failure(() => parseFormula(`${"(".repeat(4000)}1${")".repeat(4000)}`)).code).toBe("limit_exceeded");
    expect(failure(() => parseFormula(`${"-".repeat(8000)}1`)).code).toBe("limit_exceeded");
    expect(failure(() => parseFormula(`1${"+1".repeat(MAX_AST_DEPTH + 10)}`)).code).toBe("limit_exceeded");
  });

  it("accepts long chains and deep nesting below the limit", () => {
    const chain = parseFormula(`1${"+1".repeat(500)}`) as FormulaAst;
    expect(chain.type).toBe("binary");
    expect(parseFormula(`${"(".repeat(200)}1${")".repeat(200)}`).type).toBe("paren");
    expect(parseFormula(`${"IF(1,".repeat(64)}0${",0)".repeat(64)}`).type).toBe("call");
  });

  it("rejects more than 255 arguments", () => {
    expect(parseFormula(`SUM(${"1,".repeat(254)}1)`)).toMatchObject({ type: "call" });
    expect(failure(() => parseFormula(`SUM(${"1,".repeat(255)}1)`))).toEqual({ code: "formula_error", offset: 0 });
  });

  it("rejects input that is not text", () => {
    expect(failure(() => parseFormula(42 as unknown as string)).code).toBe("invalid_argument");
  });
});
