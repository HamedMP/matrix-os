import { describe, expect, it } from "vitest";
import { createXlsx, parseA1 } from "../../../../../packages/office/src/xlsx/index.js";
import { mode } from "../../../../../packages/office/src/xlsx/formula/functions/stat/compute.js";
import { check, err, setup, type Case } from "./setup.js";

const { value, run } = setup();

const table = (name: string, cases: Case[]) =>
  describe(name, () => {
    it.each(cases)("%s -> %j", (text, expected) => check(value, text, expected));
  });

table("AVERAGE and AVERAGEA", [
  ["AVERAGE(A1:A5)", 30],
  ["AVERAGE(C1:C5)", 3],
  ['AVERAGE("4",TRUE)', 2.5],
  ["AVERAGE(A1:A2,60)", 30],
  ["AVERAGE(B1:B5)", "#DIV/0!"],
  ["AVERAGE(E1:E5)", "#N/A"],
  ['AVERAGE("x")', "#VALUE!"],
  ["AVERAGEA(C1:C5)", 1.75],
  ["AVERAGEA(B1:B2,A1)", 10 / 3],
  ['AVERAGEA("x")', "#VALUE!"],
]);

table("COUNT, COUNTA, COUNTBLANK", [
  ["COUNT(C1:C5)", 2],
  ["COUNT(A1:E5)", 16],
  ['COUNT(1,"2","x",TRUE)', 3],
  ["COUNT(E1:E5,1/0)", 4],
  ["COUNTA(C1:C5)", 4],
  ["COUNTA(E1:E5)", 5],
  ["COUNTA(F1:F5)", 4],
  ['COUNTA(1,"",1/0)', 3],
  ["COUNTBLANK(C1:C5)", 1],
  ["COUNTBLANK(F1:F10)", 7],
  ["COUNTBLANK(Z1:Z4)", 4],
  ["COUNTBLANK(A1:A5)", 0],
]);

describe("MODE over many numbers", () => {
  it("counts each value once, so a long list of repeats stays quick", () => {
    const started = performance.now();
    expect(mode(new Array<number>(100_000).fill(7))).toBe(7);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("sorts the list of LARGE, SMALL and PERCENTILE once for an array of k", () => {
    const workbook = createXlsx();
    const sheet = workbook.listSheets()[0]!.id;
    const count = 20_000;
    workbook.setRange(sheet, parseA1("A1"), Array.from({ length: count }, (_, i) => [count - i]));
    workbook.setFormula(sheet, parseA1("B1"), `SUM(SMALL(A1:A${count},ROW(A1:A${count})))`);
    workbook.setFormula(sheet, parseA1("B2"), `SUM(LARGE(A1:A${count},ROW(A1:A${count})))`);
    workbook.setFormula(sheet, parseA1("B3"), `SUM(PERCENTILE(A1:A${count},ROW(A1:A${count})/${count}))`);
    const started = performance.now();
    workbook.recalc();
    expect(performance.now() - started).toBeLessThan(2_000);
    const total = (count * (count + 1)) / 2;
    expect([0, 1].map((row) => workbook.getCell(sheet, { row, col: 1 }).value)).toEqual([total, total]);
    // PERCENTILE(1..n, i/n) is 1 + i(n-1)/n.
    expect(workbook.getCell(sheet, { row: 2, col: 1 }).value).toBeCloseTo(count + (count * count - 1) / 2, 3);
  });

  it("keeps the first of the most frequent values", () => {
    expect(mode([1, 2, 2, 3, 3, 3, 1, 1])).toBe(1);
    expect(mode([5, 4, 4, 5, 6])).toBe(5);
    expect(mode([0, -0, 2])).toBe(0);
  });
});

table("MEDIAN, MODE, STDEV, VAR", [
  ["MEDIAN(D1:D5)", 3],
  ["MEDIAN(1,2,3,4)", 2.5],
  ["MEDIAN(B1:B5)", "#NUM!"],
  ["MEDIAN(E1:E5)", "#N/A"],
  ["MODE(D1:D5)", 1],
  ["MODE.SNGL(2,2,3,3)", 2],
  ["MODE(3,3,2,2)", 3],
  ["MODE(1,2,3)", "#N/A"],
  ["STDEV(D1:D5)", Math.sqrt(3.2)],
  ["STDEV.S(D1:D5)", Math.sqrt(3.2)],
  ["STDEVP(D1:D5)", 1.6],
  ["STDEV.P(D1:D5)", 1.6],
  ["VAR(D1:D5)", 3.2],
  ["VAR.S(D1:D5)", 3.2],
  ["VARP(D1:D5)", 2.56],
  ["VAR.P(D1:D5)", 2.56],
  ["VAR.P(5)", 0],
  ["STDEV(5)", "#DIV/0!"],
  ["VAR.S(B1:B5)", "#DIV/0!"],
  ["STDEV.P(E1:E5)", "#N/A"],
]);

table("LARGE, SMALL, RANK", [
  ["LARGE(A1:A5,2)", 40],
  ["LARGE(A1:A5,1)", 50],
  ["SMALL(A1:A5,2)", 20],
  ["SMALL(D1:D5,2)", 1],
  ["LARGE(C1:C5,1)", 5],
  ["LARGE(A1:A5,6)", "#NUM!"],
  ["LARGE(A1:A5,0)", "#NUM!"],
  ["SMALL(B1:B5,1)", "#NUM!"],
  ["LARGE(E1:E5,1)", "#N/A"],
  ['SMALL(A1:A5,"x")', "#VALUE!"],
  ["RANK(30,A1:A5)", 3],
  ["RANK(10,A1:A5)", 5],
  ["RANK(10,A1:A5,1)", 1],
  ["RANK.EQ(1,D1:D5)", 4],
  ["RANK.AVG(1,D1:D5)", 4.5],
  ["RANK.AVG(1,D1:D5,1)", 1.5],
  ["RANK(7,A1:A5)", "#N/A"],
  ["RANK(2,E1:E5)", "#N/A"],
]);

table("PERCENTILE and QUARTILE", [
  ["PERCENTILE(A1:A5,0.25)", 20],
  ["PERCENTILE(A1:A5,0.1)", 14],
  ["PERCENTILE.INC(A1:A5,1)", 50],
  ["PERCENTILE.INC(A1:A5,0)", 10],
  ["PERCENTILE.EXC(A1:A5,0.25)", 15],
  ["PERCENTILE(A1:A5,1.5)", "#NUM!"],
  ["PERCENTILE.EXC(A1:A5,0.1)", "#NUM!"],
  ["PERCENTILE(B1:B5,0.5)", "#NUM!"],
  ["QUARTILE(A1:A5,1)", 20],
  ["QUARTILE.INC(A1:A5,2)", 30],
  ["QUARTILE(A1:A5,4)", 50],
  ["QUARTILE(A1:A5,1.9)", 20],
  ["QUARTILE(A1:A5,5)", "#NUM!"],
  ["QUARTILE.EXC(A1:A5,1)", 15],
  ["QUARTILE.EXC(A1:A5,3)", 45],
  ["QUARTILE.EXC(A1:A5,0)", "#NUM!"],
]);

table("CORREL", [
  ["CORREL(A1:A5,D1:D5)", 1 / (2 * Math.SQRT2)],
  ["CORREL(A1:A5,A1:A5)", 1],
  ["CORREL({1,2,3},{3,2,1})", -1],
  ["CORREL(A1:A5,C1:C5)", 1],
  ["CORREL(A1:A5,A1:A4)", "#N/A"],
  ["CORREL({1,1,1},{1,2,3})", "#DIV/0!"],
  ["CORREL(A1:A5,E1:E5)", "#N/A"],
]);

table("COUNTIF criteria", [
  ["COUNTIF(A1:A5,\">25\")", 3],
  ["COUNTIF(A1:A5,\">=30\")", 3],
  ["COUNTIF(A1:A5,\"<30\")", 2],
  ["COUNTIF(A1:A5,\"<=30\")", 3],
  ["COUNTIF(A1:A5,30)", 1],
  ["COUNTIF(A1:A5,\"=30\")", 1],
  ["COUNTIF(A1:A5,\"<>30\")", 4],
  ["COUNTIF(B1:B5,\"apple\")", 2],
  ["COUNTIF(B1:B5,\"APPLE\")", 2],
  ["COUNTIF(B1:B5,\"a*\")", 3],
  ["COUNTIF(B1:B5,\"?pple\")", 2],
  ["COUNTIF(B1:B5,\"*an*\")", 1],
  ["COUNTIF(B1:B5,\"*e\")", 2],
  ["COUNTIF(B1:B5,\"<>apple\")", 3],
  ["COUNTIF(B1:B5,\">b\")", 2],
  ["COUNTIF(B1:B5,\"<b\")", 3],
  ["COUNTIF(F1:F5,\"a~*\")", 1],
  ["COUNTIF(F1:F5,\"~?\")", 1],
  ["COUNTIF(F1:F5,\"?\")", 2],
  ["COUNTIF(F1:F5,\"*\")", 4],
  ["COUNTIF(F1:F5,\"\")", 2],
  ["COUNTIF(F1:F5,\"=\")", 1],
  ["COUNTIF(F1:F5,\"<>\")", 4],
  ["COUNTIF(H1:H3,10)", 2],
  ["COUNTIF(H1:H3,\"10\")", 2],
  ["COUNTIF(H1:H3,\">5\")", 1],
  ["COUNTIF(C1:C5,TRUE)", 1],
  ["COUNTIF(C1:C5,\"TRUE\")", 1],
  ["COUNTIF(C1:C5,1)", 1],
  ["COUNTIF(E1:E5,\"#N/A\")", 1],
  ["COUNTIF(E1:E5,E2)", 1],
  ["COUNTIF(E1:E5,\">5\")", 3],
  ["COUNTIF(E1:E5,\"<>#N/A\")", 4],
  ["COUNTIF(A1:A5,Z99)", 0],
  ["COUNTIF(G1:G3,\">2024-02-01\")", 2],
  ["COUNTIF(G1:G3,\"<=2024-02-15\")", 2],
  ["COUNTIF(A1:A5,\">\"&A2)", 3],
  ["COUNTIF(F:F,\"\")", 1048573],
  ["COUNTIF(A:A,\">0\")", 5],
  ["COUNTIF(A1:A5,1/0)", 0],
]);

table("COUNTIFS, SUMIF, SUMIFS", [
  ["COUNTIFS(A1:A5,\">15\",B1:B5,\"a*\")", 2],
  ["COUNTIFS(A1:A5,\">15\")", 4],
  ["COUNTIFS(A:A,\">0\",B:B,\"a*\")", 3],
  ["COUNTIFS(Z1:Z10,\"\",Y1:Y10,\"\")", 10],
  ["COUNTIFS(A1:A5,\">15\",B1:B3,\"a*\")", "#VALUE!"],
  ["COUNTIFS(A1:A5,\">15\",B1:B5)", "#VALUE!"],
  ["SUMIF(A1:A5,\">25\")", 120],
  ["SUMIF(B1:B5,\"apple\",A1:A5)", 40],
  ["SUMIF(B1:B5,\"ap*\",A1:A5)", 90],
  ["SUMIF(B1:B5,\"<>apple\",A1:A5)", 110],
  ["SUMIF(B1:B5,\"apple\",A1)", 40],
  ["SUMIF(B1:B5,\"apple\",A1:A2)", 40],
  ["SUMIF(E1:E5,\">5\")", 24],
  ["SUMIF(A1:A5,\"<15\",E1:E5)", 2],
  ["SUMIF(A1:A5,\">0\",E1:E5)", "#N/A"],
  ["SUMIF(B1:B5,\"zzz\",A1:A5)", 0],
  ["SUMIF(A:A,\">25\")", 120],
  ["SUMIFS(A1:A5,B1:B5,\"a*\",A1:A5,\"<50\")", 40],
  ["SUMIFS(A1:A5,B1:B5,\"a*\")", 90],
  ["SUMIFS(E1:E5,A1:A5,\">=30\")", 24],
  ["SUMIFS(E1:E5,A1:A5,\">=20\")", "#N/A"],
  ["SUMIFS(A1:A5,B1:B4,\"a*\")", "#VALUE!"],
  ["SUMIFS(A1:A5,B1:B5)", "#VALUE!"],
]);

table("AVERAGEIF, AVERAGEIFS, MAXIFS, MINIFS", [
  ["AVERAGEIF(A1:A5,\">25\")", 40],
  ["AVERAGEIF(B1:B5,\"a*\",A1:A5)", 30],
  ["AVERAGEIF(B1:B5,\"zzz\",A1:A5)", "#DIV/0!"],
  ["AVERAGEIF(B1:B5,\"apple\",B1:B5)", "#DIV/0!"],
  ["AVERAGEIFS(A1:A5,B1:B5,\"a*\")", 30],
  ["AVERAGEIFS(A1:A5,B1:B5,\"a*\",D1:D5,\">3\")", 40],
  ["AVERAGEIFS(A1:A5,B1:B5,\"zzz\")", "#DIV/0!"],
  ["MAXIFS(A1:A5,B1:B5,\"a*\")", 50],
  ["MINIFS(A1:A5,B1:B5,\"a*\")", 10],
  ["MAXIFS(A1:A5,B1:B5,\"zzz\")", 0],
  ["MINIFS(D1:D5,A1:A5,\">15\",B1:B5,\"<>cherry\")", 1],
  ["MAXIFS(E1:E5,A1:A5,\">10\")", "#N/A"],
  ["MAXIFS(A1:A5,B1:B4,\"a*\")", "#VALUE!"],
]);

describe("array criteria", () => {
  it("gives one result per criterion", () => {
    expect(run('COUNTIF(B1:B5,{"apple","cherry"})')).toMatchObject({ kind: "array", values: [[2, 1]] });
    expect(run('SUMIF(B1:B5,{"apple";"banana"},A1:A5)')).toMatchObject({ kind: "array", values: [[40], [20]] });
  });
  it("applies SMALL to an array of k", () => {
    expect(run("SMALL(D1:D5,{1,3})")).toMatchObject({ kind: "array", values: [[1, 3]] });
  });
});

describe("cell limit", () => {
  it.each([
    // A1:A5 (5), D1 (1), and D1:D5 read again at the size of the criteria range (5).
    ['SUMIF(A1:A5,">0",D1)', 11, 14],
    ['AVERAGEIF(A1:A5,">0",D1)', 11, 2.8],
  ] as const)("counts the resized sum range of %s against maxCells", (text, cells, expected) => {
    expect(setup({ maxCells: cells }).value(text)).toBe(expected);
    expect(setup({ maxCells: cells - 1 }).value(text)).toEqual(err("#NUM!"));
  });
});
