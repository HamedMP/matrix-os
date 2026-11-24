import { describe, expect, it } from "vitest";
import type { FormulaArray, FormulaError, FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import { err, setup } from "./eval-setup.js";

describe("core functions", () => {
  const { value, run, provider } = setup();

  it.each<[string, FormulaScalar]>([
    ["SUM(1,2,3)", 6],
    ["SUM(A1:A3)", 6],
    ["SUM(A1:A3,B1:B3,5)", 71],
    ['SUM("2",TRUE)', 3],
    ["SUM(C1:C3)", 0],
    ["SUM(C2)", 0],
    ["SUM(A1:A3)/SUM(B1:B3)", 0.1],
    ["IF(TRUE,1,2)", 1],
    ["IF(FALSE,1,2)", 2],
    ["IF(A1>0,\"pos\",\"neg\")", "pos"],
    ["IF(A4,1,2)", 2],
    ["IF(FALSE,1)", false],
    ["IF(TRUE,,2)", null],
    ['IF("true",1,2)', 1],
    ["IF(D1,1,2)", 1],
    ["IFERROR(1/0,\"oops\")", "oops"],
    ["IFERROR(5,\"oops\")", 5],
    ["IFERROR(B4,0)", 0],
    ["IFERROR(NoName,-1)", -1],
    ["IFERROR(1/0,)", null],
    ["AND(TRUE,1,\"true\")", true],
    ["AND(TRUE,0)", false],
    ["AND(A1:A3)", true],
    ["AND(A1:A3,D2)", false],
    ["OR(FALSE,0)", false],
    ["OR(FALSE,2)", true],
    ["OR(A4,D2,A1)", true],
    ["AND(C1:C3)", true],
    ["NOT(TRUE)", false],
    ["NOT(0)", true],
    ["NOT(A4)", true],
    ["IF(AND(A1=1,OR(B1=5,B1=10)),SUM(A1:A3)*2,0)", 12],
  ])("%s is %j", (text, expected) => {
    expect(value(text)).toBe(expected);
  });

  it.each<[string, FormulaError["code"]]>([
    ['IF("abc",1,2)', "#VALUE!"],
    ["IF(1/0,1,2)", "#DIV/0!"],
    ['SUM("abc")', "#VALUE!"],
    ['AND("abc")', "#VALUE!"],
    ["AND(C1)", "#VALUE!"],
    ["AND(TRUE,1/0)", "#DIV/0!"],
    ["OR(B4,TRUE)", "#DIV/0!"],
    ["OR(D2,B4:B4,TRUE)", "#DIV/0!"],
    ["AND(B1:B4)", "#DIV/0!"],
    ['NOT("abc")', "#VALUE!"],
    ["NOT(#N/A)", "#N/A"],
    ["IFERROR(1/0,#N/A)", "#N/A"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });

  it("evaluates only the branch that is needed", () => {
    provider.reads.length = 0;
    expect(value("IF(TRUE,A1,B1)")).toBe(1);
    expect(provider.reads).toEqual(["Sheet1!0,0"]);
    provider.reads.length = 0;
    expect(value("IF(FALSE,1/0,B1)")).toBe(10);
    expect(provider.reads).toEqual(["Sheet1!0,1"]);
    provider.reads.length = 0;
    expect(value("IFERROR(A1,B1)")).toBe(1);
    expect(provider.reads).toEqual(["Sheet1!0,0"]);
  });

  it("stops AND and OR at the argument that decides", () => {
    provider.reads.length = 0;
    expect(value("AND(FALSE,1/0,B1)")).toBe(false);
    expect(value("OR(TRUE,1/0,B1)")).toBe(true);
    expect(value("AND(D2,B4)")).toBe(false);
    expect(provider.reads).toEqual(["Sheet1!1,3"]);
  });

  it("applies IF and IFERROR element by element to arrays", () => {
    expect((run('IF(A1:A3>1,"big","small")') as FormulaArray).values).toEqual([["small"], ["big"], ["big"]]);
    expect((run("IF(A1:A3>1,B1:B3,0)") as FormulaArray).values).toEqual([[0], [20], [30]]);
    expect((run("IFERROR(B1:B4,-1)") as FormulaArray).values).toEqual([[10], [20], [30], [-1]]);
    expect((run("NOT(A1:A3>1)") as FormulaArray).values).toEqual([[true], [false], [false]]);
    expect(value("SUM(IF(A1:A3>1,B1:B3,0))")).toBe(50);
  });

  it("keeps a reference returned by IF a reference", () => {
    expect(run("IF(TRUE,A1:A3,0)")).toMatchObject({ rows: 3, ref: { sheet: "Sheet1", endRow: 2 } });
    expect(value("SUM(IF(TRUE,A1:A3,0))")).toBe(6);
  });
});
