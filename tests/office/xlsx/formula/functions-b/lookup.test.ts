import { describe, expect, it } from "vitest";
import type { FormulaArray, FormulaError, FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import { err, setup } from "./setup.js";

// Sheet1: A1:A5 = 1,2,3,5,8; B1:B5 = apple, Banana, cherry, date, elder;
// C1:C5 = 0.5, 0.25, 3, 1.75, 2; E1:G1 = x,y,z; E2:G2 = 10,20,30.
describe("lookup functions", () => {
  const { value, run } = setup();

  it.each<[string, FormulaScalar]>([
    ["VLOOKUP(3,A1:C5,2,FALSE)", "cherry"],
    ["VLOOKUP(4,A1:C5,2)", "cherry"],
    ["VLOOKUP(4,A1:C5,2,TRUE)", "cherry"],
    ["VLOOKUP(100,A1:C5,3)", 2],
    ['VLOOKUP("BANANA",B1:C5,2,FALSE)', 0.25],
    ['VLOOKUP("ch*",B1:C5,2,FALSE)', 3],
    ['VLOOKUP("?ate",B1:C5,2,FALSE)', 1.75],
    ['VLOOKUP("c",B1:C5,2,TRUE)', 0.25],
    ['VLOOKUP("zzz",B1:C5,2)', 2],
    ['HLOOKUP("y",E1:G2,2,FALSE)', 20],
    ['HLOOKUP("yy",E1:G2,2)', 20],
    ['HLOOKUP("Z",E1:G2,1,FALSE)', "z"],
    ["LOOKUP(4,A1:A5,B1:B5)", "cherry"],
    ["LOOKUP(4,A1:C5)", 3],
    ['LOOKUP("y",E1:G2)', 20],
    ["LOOKUP(2,1/(A1:A5>2),B1:B5)", "elder"],
    ["LOOKUP(3,A1:A5,E2:G2)", 30],
    ["MATCH(5,A1:A5,0)", 4],
    ["MATCH(5,A1:A5,)", 4],
    ["MATCH(6,A1:A5)", 4],
    ["MATCH(6,A1:A5,1)", 4],
    ['MATCH("CHERRY",B1:B5,0)', 3],
    ['MATCH("*rr*",B1:B5,0)', 3],
    ["MATCH(9.99E+307,A1:A5)", 5],
    ["MATCH(5,{8,5,3,2,1},-1)", 2],
    ["MATCH(4,{8,5,3,2,1},-1)", 2],
    ['MATCH("y",E1:G1,0)', 2],
    ['MATCH("~*",{"a","*"},0)', 2],
    ["XMATCH(5,A1:A5)", 4],
    ["XMATCH(4,A1:A5,-1)", 3],
    ["XMATCH(4,A1:A5,1)", 4],
    ['XMATCH("ch*",B1:B5,2)', 3],
    ["XMATCH(4,A1:A5,1,2)", 4],
    ["XMATCH(4,A1:A5,-1,2)", 3],
    ["XMATCH(5,A1:A5,0,2)", 4],
    ["XMATCH(4,{8,5,3,2,1},-1,-2)", 3],
    ["XMATCH(4,{8,5,3,2,1},1,-2)", 2],
    ["XMATCH(1,{1,2,1},0,-1)", 3],
    ["XMATCH(4,{3,8,5,1},-1)", 1],
    ["XMATCH(4,{3,8,5,1},1)", 3],
    ["XLOOKUP(3,A1:A5,B1:B5)", "cherry"],
    ['XLOOKUP(4,A1:A5,B1:B5,"none")', "none"],
    ["XLOOKUP(4,A1:A5,B1:B5,,-1)", "cherry"],
    ["XLOOKUP(4,A1:A5,B1:B5,,1)", "date"],
    ['XLOOKUP("y",E1:G1,E2:G2)', 20],
    ['XLOOKUP("CH*",B1:B5,A1:A5,,2)', 3],
    ["XLOOKUP(1,{1;2;1},{10;20;30},,0,-1)", 30],
    ["SUM(XLOOKUP(2,A1:A5,C1:C5):C5)", 7],
    ["INDEX(A1:C5,2,2)", "Banana"],
    ["INDEX(A1:A5,3)", 3],
    ["INDEX(E1:G1,2)", "y"],
    ["SUM(INDEX(A1:C5,0,3))", 7.5],
    ["INDEX({1,2;3,4},2,1)", 3],
    ["INDEX(7,1,1)", 7],
    ["ROW(INDEX(A1:C5,3,1))", 3],
    ["SUM(A1:INDEX(A1:A5,3))", 6],
    ['CHOOSE(2,"a","b","c")', "b"],
    ['CHOOSE(2.9,"a","b","c")', "b"],
    ['CHOOSE(1,"ok",1/0)', "ok"],
    ["SUM(CHOOSE(2,A1:A5,C1:C5))", 7.5],
    ["OFFSET(A1,2,1)", "cherry"],
    ["SUM(OFFSET(A1,1,0,3,1))", 10],
    ["SUM(OFFSET(A1:A2,1,0))", 5],
    ["ROWS(OFFSET(A1,0,0,4,2))", 4],
    ["COLUMNS(OFFSET(A1,0,0,4,2))", 2],
    ['INDIRECT("B2")', "Banana"],
    ["INDIRECT(L1)", 1],
    ["INDIRECT(L2)", 42],
    ['SUM(INDIRECT("A1:A3"))', 6],
    ['INDIRECT("\'Other\'!A1")', "o-a1"],
    ['SUM(INDIRECT("Prices"))', 7.5],
    ['INDIRECT("$c$3")', 3],
    ["ROW()", 10],
    ["COLUMN()", 10],
    ["ROW(B3)", 3],
    ["COLUMN(C2)", 3],
    ["ROW(Other!B2)", 2],
    ["ROWS(A1:C5)", 5],
    ["COLUMNS(A1:C5)", 3],
    ["ROWS({1,2;3,4})", 2],
    ["COLUMNS({1,2,3})", 3],
    ["ROWS(5)", 1],
    ["ROWS(A:A)", 1048576],
    ["COLUMNS(1:1)", 16384],
  ])("%s is %j", (text, expected) => {
    expect(value(text)).toBe(expected);
  });

  it.each<[string, FormulaError["code"]]>([
    ["VLOOKUP(4,A1:C5,2,FALSE)", "#N/A"],
    ["VLOOKUP(4,A1:C5,2,)", "#N/A"],
    ["MATCH(4,A1:A5,)", "#N/A"],
    ["VLOOKUP(0,A1:C5,2)", "#N/A"],
    ["VLOOKUP(3,A1:C5,4,FALSE)", "#REF!"],
    ["VLOOKUP(3,A1:C5,0)", "#VALUE!"],
    ['VLOOKUP("3",A1:C5,2,FALSE)', "#N/A"],
    ["VLOOKUP(D7,A1:C5,2,FALSE)", "#N/A"],
    ["VLOOKUP(1/0,A1:C5,2)", "#DIV/0!"],
    ['HLOOKUP("y",E1:G2,3,FALSE)', "#REF!"],
    ["LOOKUP(0,A1:A5,B1:B5)", "#N/A"],
    ["LOOKUP(8,A1:A5,E2:G2)", "#N/A"],
    ["MATCH(0,A1:A5)", "#N/A"],
    ["MATCH(9,{8,5,3},-1)", "#N/A"],
    ["MATCH(1,A1:C5,0)", "#N/A"],
    ["MATCH(4,A1:A5,0)", "#N/A"],
    ["XMATCH(4,A1:A5)", "#N/A"],
    ['XMATCH("ch*",B1:B5)', "#N/A"],
    ['XMATCH("a",B1:B5,2,2)', "#VALUE!"],
    ["XMATCH(1,A1:A5,3)", "#VALUE!"],
    ["XMATCH(1,A1:A5,0,0)", "#VALUE!"],
    ["XMATCH(1,A1:C5)", "#VALUE!"],
    ["XLOOKUP(4,A1:A5,B1:B5)", "#N/A"],
    ["XLOOKUP(3,A1:A4,B1:B5)", "#VALUE!"],
    ["INDEX(A1:C5,6,1)", "#REF!"],
    ["INDEX(A1:C5,1,4)", "#REF!"],
    ["INDEX(A1:C5,-1,1)", "#VALUE!"],
    ["INDEX(A1:C5,1,1,2)", "#REF!"],
    ['CHOOSE(4,"a","b")', "#VALUE!"],
    ['CHOOSE(0,"a")', "#VALUE!"],
    ['CHOOSE("x","a")', "#VALUE!"],
    ["OFFSET(A1,-1,0)", "#REF!"],
    ["OFFSET(A1,0,0,0,1)", "#REF!"],
    ["OFFSET(5,1,1)", "#VALUE!"],
    ["OFFSET(A1,1/0,1)", "#DIV/0!"],
    ["INDIRECT(L3)", "#REF!"],
    ["INDIRECT(L4)", "#REF!"],
    ['INDIRECT("A1",FALSE)', "#REF!"],
    ['INDIRECT("")', "#REF!"],
    ['INDIRECT("A1+1")', "#REF!"],
    ['INDIRECT("NoSuchName")', "#NAME?"],
    ["ROW(5)", "#VALUE!"],
    ["ROWS(1/0)", "#DIV/0!"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });

  it.each<[string, FormulaScalar[][]]>([
    ["XLOOKUP(3,A1:A5,B1:C5)", [["cherry", 3]]],
    ["XLOOKUP({2;5},A1:A5,B1:B5)", [["Banana"], ["date"]]],
    ["INDEX(A1:C5,2)", [[2, "Banana", 0.25]]],
    ['CHOOSE({1,2},"a","b")', [["a", "b"]]],
    ["ROW(A2:A4)", [[2], [3], [4]]],
    ["COLUMN(A1:C1)", [[1, 2, 3]]],
    ["TRANSPOSE({1,2,3})", [[1], [2], [3]]],
    ["TRANSPOSE(A1:B2)", [[1, 2], ["apple", "Banana"]]],
    ["TRANSPOSE(D6:E7)", [[null, null], [null, null]]],
    ["UNIQUE({1;2;1;3;2})", [[1], [2], [3]]],
    ['UNIQUE({"a";"A";"b"})', [["a"], ["b"]]],
    ["UNIQUE({1;2;1;3;2},FALSE,TRUE)", [[3]]],
    ["UNIQUE({1,1,2},TRUE)", [[1, 2]]],
    ["UNIQUE({1,2;1,2;1,3})", [[1, 2], [1, 3]]],
    ["SORT({3;1;2})", [[1], [2], [3]]],
    ["SORT({3;1;2},1,-1)", [[3], [2], [1]]],
    ["SORT(A1:B3,2,-1)", [[3, "cherry"], [2, "Banana"], [1, "apple"]]],
    ["SORT({3,1,2},1,1,TRUE)", [[1, 2, 3]]],
    ['SORT({1,"b";2,"a";1,"a"},{1,2})', [[1, "a"], [1, "b"], [2, "a"]]],
    ['SORT({1,"b";2,"a";1,"a"},{1,2},{-1,1})', [[2, "a"], [1, "a"], [1, "b"]]],
    ['SORT({"b";1;TRUE;"A"})', [[1], ["A"], ["b"], [true]]],
    ["FILTER(B1:B5,A1:A5>2)", [["cherry"], ["date"], ["elder"]]],
    ["FILTER(A1:C5,C1:C5>1.5)", [[3, "cherry", 3], [5, "date", 1.75], [8, "elder", 2]]],
    ["FILTER(E1:G2,E2:G2>15)", [["y", "z"], [20, 30]]],
    ["FILTER({1;2;3},{TRUE;0;1})", [[1], [3]]],
  ])("%s spills %j", (text, expected) => {
    const result = run(text);
    expect(result).toMatchObject({ kind: "array" });
    expect((result as FormulaArray).values).toEqual(expected);
  });

  it.each<[string, FormulaError["code"] | FormulaScalar]>([
    ["UNIQUE({1;1},FALSE,TRUE)", "#VALUE!"],
    ["SORT({1;2},3)", "#VALUE!"],
    ["SORT({1;2},1,0)", "#VALUE!"],
    ["SORT({1;2},{1,1},{1,1,1})", "#VALUE!"],
    ["FILTER(A1:A5,A1:A5>100)", "#VALUE!"],
    ["FILTER(A1:A5,B1:B5)", "#VALUE!"],
    ["FILTER(A1:A5,A1:B2)", "#VALUE!"],
    ["FILTER({1;2},{TRUE;#N/A})", "#N/A"],
    ["UNIQUE(1/0)", "#DIV/0!"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code as FormulaError["code"]));
  });

  it("returns the if-empty value of FILTER and the if-not-found value of XLOOKUP as given", () => {
    expect(value('FILTER(A1:A5,A1:A5>100,"none")')).toBe("none");
    expect(value("XLOOKUP(9,A1:A5,B1:B5,C1)")).toBe(0.5);
    expect(run("XLOOKUP(9,A1:A5,B1:B5,{1,2})")).toMatchObject({ values: [[1, 2]] });
  });

  it("keeps INDEX, OFFSET, XLOOKUP and INDIRECT results as references", () => {
    expect(run("INDEX(A1:C5,0,2)")).toMatchObject({
      ref: { sheet: "Sheet1", startRow: 0, startCol: 1, endRow: 4, endCol: 1 },
    });
    expect(run("OFFSET(B2,1,1,2,2)")).toMatchObject({
      ref: { sheet: "Sheet1", startRow: 2, startCol: 2, endRow: 3, endCol: 3 },
    });
    expect(run("XLOOKUP(5,A1:A5,C1:C5)")).toMatchObject({ ref: { startRow: 3, startCol: 2 } });
    expect(run('INDIRECT("Other!B2")')).toMatchObject({ ref: { sheet: "Other", startRow: 1, startCol: 1 } });
    expect(run("INDEX({1,2;3,4},0,2)")).toMatchObject({ ref: null, values: [[2], [4]] });
  });

  it("marks OFFSET and INDIRECT volatile", () => {
    const { functions } = setup();
    expect(functions.describe("OFFSET")?.volatile).toBe(true);
    expect(functions.describe("INDIRECT")?.volatile).toBe(true);
    expect(functions.describe("INDEX")?.volatile).toBe(false);
  });

  it("evaluates only the chosen CHOOSE branch", () => {
    const { provider, value: v } = setup();
    provider.reads.length = 0;
    expect(v("CHOOSE(1,A1,Other!A1)")).toBe(1);
    expect(provider.reads.some((read) => read.startsWith("Other"))).toBe(false);
  });

  it("reads each CHOOSE choice once against maxCells", () => {
    // The selector (2), each choice once (5 + 5), then the 5 by 2 result (10).
    const text = "CHOOSE({1,2},A1:A5,C1:C5)";
    expect(setup({ maxCells: 22 }).run(text)).toMatchObject({ kind: "array", rows: 5, cols: 2 });
    expect(setup({ maxCells: 21 }).run(text)).toEqual(err("#NUM!"));
  });

  it("looks up in a whole column without reading past the used rows", () => {
    expect(value("VLOOKUP(5,A:C,2,FALSE)")).toBe("date");
    expect(value("MATCH(8,A:A,0)")).toBe(5);
    expect(value("XLOOKUP(8,A:A,B:B)")).toBe("elder");
  });
});
