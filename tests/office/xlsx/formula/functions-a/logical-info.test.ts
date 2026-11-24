import { describe, expect, it } from "vitest";
import { createRegistry } from "../../../../../packages/office/src/xlsx/formula/registry.js";
import { registerA } from "../../../../../packages/office/src/xlsx/formula/functions/register-a.js";
import { check, setup, type Case } from "./setup.js";

const { value, run } = setup();

const table = (name: string, cases: Case[]) =>
  describe(name, () => {
    it.each(cases)("%s -> %j", (text, expected) => check(value, text, expected));
  });

table("IF, IFS, IFERROR, IFNA", [
  ['IF(A1>5,"big","small")', "big"],
  ["IF(C4,1,2)", 2],
  ['IF("x",1,2)', "#VALUE!"],
  ['IFS(A1>15,"a",A1>5,"b")', "b"],
  ['IFS(A1>5,"a",1/0,"b")', "a"],
  ["IFS(FALSE,1,TRUE,2)", 2],
  ["IFS(FALSE,1)", "#N/A"],
  ["IFS(TRUE,1,FALSE)", "#VALUE!"],
  ['IFS("x",1)', "#VALUE!"],
  ["IFS(1/0,1)", "#DIV/0!"],
  ['IFERROR(E2,"bad")', "bad"],
  ["IFERROR(A1,0)", 10],
  ['IFNA(E2,"na")', "na"],
  ['IFNA(VLOOKUP_MISSING(1),"na")', "#NAME?"],
  ['IFNA(1/0,"na")', "#DIV/0!"],
  ['IFNA(5,"na")', 5],
]);

table("AND, OR, NOT, XOR, TRUE, FALSE", [
  ["AND(TRUE,FALSE)", false],
  ["AND(A1:A5)", true],
  ["OR(FALSE,A1>40)", false],
  ["OR(B1:B5,TRUE)", true],
  ["NOT(1)", false],
  ["XOR(TRUE,FALSE)", true],
  ["XOR(TRUE,TRUE)", false],
  ["XOR(TRUE,TRUE,TRUE)", true],
  ["XOR(C1:C5)", true],
  ["XOR(D2,D2)", false],
  ['XOR("true",0)', true],
  ["XOR(B1:B5)", "#VALUE!"],
  ['XOR("x")', "#VALUE!"],
  ["XOR(E1:E5)", "#N/A"],
  ["TRUE()", true],
  ["FALSE()", false],
  ["TRUE()+1", 2],
]);

table("SWITCH", [
  ['SWITCH(2,1,"a",2,"b")', "b"],
  ['SWITCH(3,1,"a",2,"b","other")', "other"],
  ['SWITCH(3,1,"a",2,"b")', "#N/A"],
  ['SWITCH("B","a",1,"b",2)', 2],
  ['SWITCH(1,"1","text",1,"num")', "num"],
  ['SWITCH(D3,4,"four",1/0,"never")', "four"],
  ["SWITCH(1/0,1,2)", "#DIV/0!"],
  ['SWITCH(5,1/0,"a")', "#DIV/0!"],
]);

table("IS functions", [
  ["ISBLANK(Z99)", true],
  ["ISBLANK(C4)", true],
  ['ISBLANK("")', false],
  ["ISBLANK(F3)", false],
  ["ISBLANK(0)", false],
  ["ISNUMBER(A1)", true],
  ['ISNUMBER("1")', false],
  ["ISNUMBER(G1)", true],
  ["ISTEXT(B1)", true],
  ["ISTEXT(1)", false],
  ["ISTEXT(F3)", true],
  ["ISNONTEXT(A1)", true],
  ["ISNONTEXT(Z99)", true],
  ["ISLOGICAL(TRUE)", true],
  ['ISLOGICAL("TRUE")', false],
  ["ISERROR(E2)", true],
  ["ISERROR(1/0)", true],
  ["ISERROR(1)", false],
  ["ISERR(E2)", false],
  ["ISERR(1/0)", true],
  ["ISNA(E2)", true],
  ["ISNA(1/0)", false],
  ["ISEVEN(2)", true],
  ["ISEVEN(-3)", false],
  ["ISEVEN(2.9)", true],
  ["ISEVEN(Z99)", true],
  ['ISEVEN("4")', true],
  ["ISODD(3)", true],
  ["ISODD(-3)", true],
  ["ISODD(0)", false],
  ['ISEVEN("x")', "#VALUE!"],
  ["ISEVEN(TRUE)", "#VALUE!"],
  ["ISODD(E2)", "#N/A"],
]);

table("NA, N, TYPE, ERROR.TYPE", [
  ["NA()", "#N/A"],
  ["N(5)", 5],
  ["N(TRUE)", 1],
  ["N(FALSE)", 0],
  ['N("x")', 0],
  ["N(B1)", 0],
  ["N(Z99)", 0],
  ["N(G1)", 45301],
  ["N(E2)", "#N/A"],
  ["TYPE(1)", 1],
  ['TYPE("a")', 2],
  ["TYPE(TRUE)", 4],
  ["TYPE(1/0)", 16],
  ["TYPE({1,2})", 64],
  ["TYPE(A1:A5)", 64],
  ["TYPE(A1)", 1],
  ["TYPE(B1)", 2],
  ["TYPE(Z99)", 1],
  ["ERROR.TYPE(#NULL!)", 1],
  ["ERROR.TYPE(1/0)", 2],
  ['ERROR.TYPE("a"+1)', 3],
  ["ERROR.TYPE(#REF!)", 4],
  ["ERROR.TYPE(NoSuchName)", 5],
  ["ERROR.TYPE(SQRT(-1))", 6],
  ["ERROR.TYPE(E2)", 7],
  ["ERROR.TYPE(1)", "#N/A"],
]);

describe("array behaviour", () => {
  it("applies IS functions element by element", () => {
    expect(run("ISNUMBER(C1:C3)")).toMatchObject({ kind: "array", values: [[true], [false], [false]] });
  });
  it("applies IFS element by element", () => {
    expect(run('IFS(A1:A3>15,"big",TRUE,"small")')).toMatchObject({
      kind: "array",
      values: [["small"], ["big"], ["big"]],
    });
  });
  it("replaces only #N/A in an array with IFNA", () => {
    expect(run("IFNA(E1:E3,0)")).toMatchObject({ kind: "array", values: [[2], [0], [6]] });
  });
});

describe("registerA", () => {
  const registry = createRegistry();
  registerA(registry);
  const names = [
    "SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "PRODUCT", "ABS", "ROUND", "ROUNDUP", "ROUNDDOWN", "MROUND",
    "CEILING", "FLOOR", "INT", "TRUNC", "MOD", "POWER", "SQRT", "EXP", "LN", "LOG", "LOG10", "PI", "SIGN",
    "RAND", "RANDBETWEEN", "MIN", "MAX", "QUOTIENT", "GCD", "LCM", "SUBTOTAL", "AGGREGATE", "SIN", "COS",
    "TAN", "ASIN", "ACOS", "ATAN", "ATAN2", "DEGREES", "RADIANS", "AVERAGE", "AVERAGEA", "AVERAGEIF",
    "AVERAGEIFS", "COUNT", "COUNTA", "COUNTBLANK", "COUNTIF", "COUNTIFS", "MEDIAN", "MODE", "STDEV",
    "STDEV.S", "STDEV.P", "VAR", "VAR.S", "VAR.P", "LARGE", "SMALL", "RANK", "PERCENTILE", "QUARTILE",
    "MAXIFS", "MINIFS", "CORREL", "IF", "IFS", "IFERROR", "IFNA", "AND", "OR", "NOT", "XOR", "SWITCH",
    "TRUE", "FALSE", "ISBLANK", "ISNUMBER", "ISTEXT", "ISERROR", "ISERR", "ISNA", "ISLOGICAL", "ISEVEN",
    "ISODD", "NA", "N", "TYPE", "ERROR.TYPE",
  ];
  it.each(names)("registers %s", (name) => {
    expect(registry.has(name)).toBe(true);
  });
  it("marks RAND and RANDBETWEEN volatile", () => {
    expect(registry.describe("RAND")?.volatile).toBe(true);
    expect(registry.describe("RANDBETWEEN")?.volatile).toBe(true);
    expect(registry.describe("SUM")?.volatile).toBe(false);
  });
  it("finds newer functions by their file prefix", () => {
    expect(registry.has("_xlfn.MAXIFS")).toBe(true);
    expect(registry.has("_xlfn.STDEV.S")).toBe(true);
  });
});
