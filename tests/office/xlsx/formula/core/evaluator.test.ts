import { describe, expect, it } from "vitest";
import type {
  FormulaArray,
  FormulaError,
  FormulaScalar,
  FunctionRegistry,
} from "../../../../../packages/office/src/api/formula.js";
import { isArray, makeArray } from "../../../../../packages/office/src/xlsx/formula/coerce.js";
import { evaluate, toCellResult } from "../../../../../packages/office/src/xlsx/formula/eval/index.js";
import { parseFormula } from "../../../../../packages/office/src/xlsx/formula/parser/index.js";
import { err, setup } from "./eval-setup.js";

describe("literals and arithmetic", () => {
  const { value } = setup();
  it.each<[string, FormulaScalar]>([
    ["1+2*3", 7],
    ["(1+2)*3", 9],
    ["10/4", 2.5],
    ["2^10", 1024],
    ["2^3^2", 64],
    ["-2^2", 4],
    ["2^-1", 0.5],
    ["50%", 0.5],
    ["200*10%", 20],
    ["--3", 3],
    ["-0", 0],
    ["5-5", 0],
    ['"a"&"b"', "ab"],
    ["1&2", "12"],
    ["1.5&TRUE", "1.5TRUE"],
    ['"3"+4', 7],
    ['"3"*"4"', 12],
    ["TRUE+TRUE", 2],
    ['"1,000"+1', 1001],
    ['"50%"+0', 0.5],
    ['"2024-01-15"+1', 45307],
    ['+"abc"', "abc"],
    ["0.1+0.2=0.3", true],
  ])("%s is %j", (text, expected) => {
    expect(value(text)).toBe(expected);
  });

  it.each<[string, FormulaError["code"]]>([
    ["1/0", "#DIV/0!"],
    ["0/0", "#DIV/0!"],
    ['"abc"+1', "#VALUE!"],
    ['-"abc"', "#VALUE!"],
    ['"abc"%', "#VALUE!"],
    ["0^0", "#NUM!"],
    ["0^-1", "#DIV/0!"],
    ["(-8)^0.5", "#NUM!"],
    ["10^308*10", "#NUM!"],
    ["#N/A", "#N/A"],
    ["#N/A+1", "#N/A"],
    ["1+#REF!", "#REF!"],
    ["#NUM!+#N/A", "#NUM!"],
    ["#NULL!&\"x\"", "#NULL!"],
    ["#VALUE!=1", "#VALUE!"],
    ["-#DIV/0!", "#DIV/0!"],
    ["NoSuchName", "#NAME?"],
    ["NOSUCHFUNCTION(1)", "#NAME?"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });
});

describe("comparison", () => {
  const { value } = setup();
  it.each<[string, boolean]>([
    ["1<2", true],
    ["2<=2", true],
    ["3>4", false],
    ["3>=4", false],
    ["1=1", true],
    ["1<>1", false],
    ['"a"="A"', true],
    ['"a"<"b"', true],
    ['1="1"', false],
    ['"1">99', true],
    ["TRUE>\"zzz\"", true],
    ["FALSE<TRUE", true],
    ["A4=0", true],
    ['A4=""', true],
    ["A4=FALSE", true],
    ['C4=""', true],
    ["C4=0", false],
    ["1<2=TRUE", true],
  ])("%s is %j", (text, expected) => {
    expect(value(text)).toBe(expected);
  });
});

describe("references", () => {
  it("reads cells from the formula's sheet and from named sheets", () => {
    const { value } = setup();
    expect(value("A1+B1")).toBe(11);
    expect(value("$A$2*B2")).toBe(40);
    expect(value("'Data 2'!A1+A1")).toBe(101);
    expect(value("sheet1!A1")).toBe(1);
    expect(value("A1", { sheet: "Data 2" })).toBe(100);
    expect(value("A4")).toBeNull();
    expect(value("A4+1")).toBe(1);
    expect(value('A4&"x"')).toBe("x");
    expect(value("C2+1")).toBe(13);
    expect(value("C3+1")).toBe(2);
    expect(value("C1+1")).toEqual(err("#VALUE!"));
    expect(value("B4+1")).toEqual(err("#DIV/0!"));
    expect(value("Missing!A1")).toEqual(err("#REF!"));
    expect(value("SUM(Missing!A1:A3)")).toEqual(err("#REF!"));
  });

  it("returns a reference result as an array with its bounds", () => {
    const { run } = setup();
    expect(run("A1")).toEqual({
      kind: "array",
      rows: 1,
      cols: 1,
      values: [[1]],
      ref: { sheet: "Sheet1", startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    const range = run("A1:B2") as FormulaArray;
    expect(range.values).toEqual([[1, 10], [2, 20]]);
    expect(range.ref).toEqual({ sheet: "Sheet1", startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(run("(A1)")).toMatchObject({ ref: { startRow: 0, startCol: 0 } });
    expect(run("A1+0")).toBe(1);
  });

  it("keeps the full bounds of a whole column while reading only the used part", () => {
    const { run, value } = setup();
    const column = run("A:A") as FormulaArray;
    expect(column.rows).toBe(4);
    expect(column.ref).toMatchObject({ startRow: 0, endRow: 1_048_575, startCol: 0, endCol: 0 });
    expect(value("SUM(A:A)")).toBe(6);
    expect(value("SUM(1:1)")).toBe(11);
    expect(value("SUM('Data 2'!A:B)")).toBe(300);
    const empty = run("Empty!A:A") as FormulaArray;
    expect(empty).toMatchObject({ rows: 0, cols: 0, values: [] });
    expect(value("SUM(Empty!A:C)")).toBe(0);
    expect(value("Empty!A:A+1")).toBe(1);
    expect(value("SUM(Z1:Z9)")).toBe(0);
  });

  it("resolves defined names, with sheet scope first", () => {
    const { value, run } = setup();
    expect(value("Rate*10")).toBe(5);
    expect(value("SUM(Items)")).toBe(6);
    expect(value("SUM(Items)", { sheet: "Data 2" })).toBe(6);
    expect(value("First", { sheet: "Data 2" })).toBe(1);
    expect((run("Items") as FormulaArray).ref).toMatchObject({ sheet: "Sheet1", endRow: 2 });
    expect(value("Deep1")).toBe(2);
    expect(value("Local", { sheet: "Data 2" })).toBe(7);
    expect(value("'Data 2'!Local")).toBe(7);
    expect(value("Local")).toEqual(err("#NAME?"));
  });
});

describe("arrays", () => {
  const { run, value } = setup();

  it("evaluates array constants", () => {
    expect(run('{1,"a";TRUE,#N/A}')).toEqual({
      kind: "array",
      rows: 2,
      cols: 2,
      values: [[1, "a"], [true, err("#N/A")]],
      ref: null,
    });
    expect(value("SUM({1,2;3,4})")).toBe(10);
  });

  it("broadcasts operators over ranges and arrays", () => {
    expect((run("A1:A3*2") as FormulaArray).values).toEqual([[2], [4], [6]]);
    expect((run("A1:A3*B1:B3") as FormulaArray).values).toEqual([[10], [40], [90]]);
    expect((run("{1,2,3}+{10;20}") as FormulaArray).values).toEqual([[11, 12, 13], [21, 22, 23]]);
    expect((run("-A1:A3") as FormulaArray).values).toEqual([[-1], [-2], [-3]]);
    expect((run("A1:A3>1") as FormulaArray).values).toEqual([[false], [true], [true]]);
    expect((run('A1:A2&"!"') as FormulaArray).values).toEqual([["1!"], ["2!"]]);
    expect((run("A1:A3*2") as FormulaArray).ref).toBeNull();
    expect(value("SUM(A1:A3*B1:B3)")).toBe(140);
    expect(value("SUM((A1:A3>1)*B1:B3)")).toBe(50);
  });

  it("broadcasts a reference over its full bounds, reading cells after its stored values as blank", () => {
    // Sheet1 is used up to row 4 and column D: A3:A6 stores two rows, B4:B6 and D1:F1 store one cell.
    expect((run("A3:A6+{1;2;3;4}") as FormulaArray).values).toEqual([[4], [2], [3], [4]]);
    expect((run("B4:B6+{1;2;3}") as FormulaArray).values).toEqual([[err("#DIV/0!")], [2], [3]]);
    expect((run('D1:F1&"x"') as FormulaArray).values).toEqual([["TRUEx", "x", "x"]]);
    expect(value("SUM(A3:A6+{1;2;3;4})")).toBe(13);
    expect((run("DOUBLE(B4:B6)") as FormulaArray).values).toEqual([[err("#DIV/0!")], [0], [0]]);
    expect((run("IFERROR(B4:B6,9)") as FormulaArray).values).toEqual([[9], [null], [null]]);
    expect((run('IF(D1:F1="TRUE",1,2)') as FormulaArray).values).toEqual([[1, 2, 2]]);
    // A whole column covers the used rows of its sheet.
    expect((run("A:A+{1;2;3;4;5}") as FormulaArray).values).toEqual([[2], [4], [6], [4], [5]]);
    expect((run("A:A*2") as FormulaArray).rows).toBe(4);
    expect((run("A2:A1048576*2") as FormulaArray).rows).toBe(3);
  });

  it("propagates errors element by element", () => {
    expect((run("B1:B4+1") as FormulaArray).values).toEqual([[11], [21], [31], [err("#DIV/0!")]]);
    expect((run("{1,2}+{1,2,3}") as FormulaArray).values).toEqual([[2, 4, err("#N/A")]]);
    expect(value("SUM(B1:B4)")).toEqual(err("#DIV/0!"));
  });
});

describe("function calls", () => {
  it("checks the number of arguments before calling", () => {
    const { value } = setup();
    expect(value("NOT()")).toEqual(err("#VALUE!"));
    expect(value("NOT(1,2)")).toEqual(err("#VALUE!"));
    expect(value("IF(1)")).toEqual(err("#VALUE!"));
    expect(value("IF(1,2,3,4)")).toEqual(err("#VALUE!"));
    expect(value("SUM()")).toEqual(err("#VALUE!"));
  });

  it("passes ranges to arguments that accept them and scalars to the rest", () => {
    const { value, run } = setup();
    expect(value("ISREF(A1)")).toBe(true);
    expect(value("ISREF(A1:A3)")).toBe(true);
    expect(value("ISREF(A1+0)")).toBe(false);
    expect(value("ISREF({1,2})")).toBe(false);
    expect(value("COUNTCELLS(A1:B2,5,{1,2,3})")).toBe(8);
    expect(value("DOUBLE(A2)")).toBe(4);
    expect(value("DOUBLE(4)")).toBe(8);
    expect((run("DOUBLE(A1:A3)") as FormulaArray).values).toEqual([[2], [4], [6]]);
    expect((run("DOUBLE({1,2;3,4})") as FormulaArray).values).toEqual([[2, 4], [6, 8]]);
    expect((run("DOUBLE(B3:B4)") as FormulaArray).values).toEqual([[60], [err("#DIV/0!")]]);
    expect(value("SUM(DOUBLE(A1:A3))")).toBe(12);
    expect(value("DOUBLE(Empty!A:A)")).toBe(0);
  });

  it("gives a missing argument as blank", () => {
    const { value, functions } = setup();
    functions.register("ARGS", (args) => args.map((a) => (a === null ? "_" : String(a))).join("|"));
    expect(value("ARGS(1,,3)")).toBe("1|_|3");
    expect(value("ARGS(,)")).toBe("_|_");
    expect(value("ARGS()")).toBe("");
  });

  it("turns a number result that is not finite into #NUM!", () => {
    const { value } = setup();
    expect(value("BOOM()")).toEqual(err("#NUM!"));
  });

  it("turns a RangeError from a function into #NUM! and passes other exceptions on", () => {
    const { value, functions } = setup();
    expect(value("THROWS()")).toEqual(err("#NUM!"));
    functions.register("BUG", () => {
      throw new TypeError("defect");
    });
    expect(() => value("BUG()")).toThrowError(TypeError);
  });

  it("lets a lazy function read the reference itself", () => {
    const { value } = setup();
    expect(value("ROWOF(B3)")).toBe(3);
    expect(value("ROWOF(B3:C9)")).toBe(3);
    expect(value("ROWOF(Items)")).toBe(1);
    expect(value("ROWOF(5)")).toEqual(err("#VALUE!"));
  });

  it("works with any registry that implements the contract", () => {
    const { provider } = setup();
    const functions: FunctionRegistry = {
      register: () => undefined,
      registerLazy: () => undefined,
      has: (name) => name === "FIRST",
      names: () => ["FIRST"],
      get: (name) =>
        name === "FIRST"
          ? { name, minArgs: 1, maxArgs: 1, volatile: false, lazy: false, impl: ([v]) => (isArray(v ?? null) ? "range" : "scalar") }
          : null,
    };
    const context = { provider, functions, sheet: "Sheet1", row: 0, col: 5 };
    expect(evaluate(parseFormula("FIRST(A1:A3)"), context)).toBe("range");
    expect(evaluate(parseFormula("FIRST(A1)"), context)).toBe("range");
    expect(evaluate(parseFormula("FIRST(1)"), context)).toBe("scalar");
    expect(evaluate(parseFormula("FIRST()"), context)).toEqual(err("#VALUE!"));
    expect(evaluate(parseFormula("SUM(1)"), context)).toEqual(err("#NAME?"));
  });

  it("finds functions with the file prefix and in any case", () => {
    const { value } = setup();
    expect(value("_xlfn.SUM(1,2)")).toBe(3);
    expect(value("sum(1,2)")).toBe(3);
  });
});

describe("reference operators and sheet spans", () => {
  it("evaluates range, intersection and union", () => {
    const { run, value } = setup();
    expect((run("A1:A2:B3") as FormulaArray).ref).toMatchObject({ startRow: 0, startCol: 0, endRow: 2, endCol: 1 });
    expect(value("SUM(A1:First)")).toBe(1);
    expect(value("SUM(First:B2)")).toBe(33);
    expect(value("SUM(A1:B2 B1:B3)")).toBe(30);
    expect(value("A1:B2 B2:C3")).toBe(20);
    expect(value("A1:A2 B1:B2")).toEqual(err("#NULL!"));
    expect(value("SUM((A1:A3,B1))")).toBe(16);
    expect(value("SUM((A1,A2,(A3,B1)),100)")).toBe(116);
    expect(value("COUNTCELLS((A1:A3,B1:B2))")).toBe(5);
    expect(value("(A1,B1)")).toEqual(err("#VALUE!"));
    expect(value("First:'Data 2'!A2")).toEqual(err("#VALUE!"));
    expect(value("SUM(A1:Rate)")).toEqual(err("#VALUE!"));
    expect(value("NOT((A1,B1))")).toEqual(err("#VALUE!"));
  });

  it("evaluates a reference across sheets when the sheet order is known", () => {
    const { value } = setup({ sheetNames: () => ["Sheet1", "Empty", "Data 2", "Other"] });
    expect(value("SUM('Sheet1:Data 2'!A1)")).toBe(101);
    expect(value("SUM('Data 2:Sheet1'!A1:A2)")).toBe(303);
    expect(value("SUM(Sheet1:Sheet1!A1:A3)")).toBe(6);
    expect(value("Sheet1:Sheet1!A2")).toBe(2);
    expect(value("Sheet1:Empty!A2")).toEqual(err("#VALUE!"));
    expect(value("SUM(Sheet1:Nowhere!A1)")).toEqual(err("#REF!"));
    expect(setup().value("SUM('Sheet1:Data 2'!A1)")).toEqual(err("#REF!"));
  });
});

describe("guards", () => {
  it("ends a name that refers to itself with #NUM!", () => {
    const { value } = setup();
    expect(value("Loop")).toEqual(err("#NUM!"));
    expect(value("IFERROR(Loop,\"guarded\")")).toBe("guarded");
  });

  it("limits the nesting of names and function calls", () => {
    const { value } = setup({ maxDepth: 3 });
    expect(value("NOT(NOT(NOT(TRUE)))")).toBe(false);
    expect(value("NOT(NOT(NOT(NOT(TRUE))))")).toEqual(err("#NUM!"));
    expect(value("Deep1")).toBe(2);
    expect(setup({ maxDepth: 1 }).value("Deep1")).toEqual(err("#NUM!"));
    const nested = `${"NOT(".repeat(300)}TRUE${")".repeat(300)}`;
    expect(setup().value(nested)).toEqual(err("#NUM!"));
    expect(setup({ maxDepth: 400 }).value(nested)).toBe(true);
  });

  it("evaluates long chains and deep nesting without overflowing the stack", () => {
    const { value } = setup();
    expect(value(`1${"+1".repeat(1000)}`)).toBe(1001);
    expect(value(`${"(".repeat(500)}7${")".repeat(500)}`)).toBe(7);
    expect(value(`${"-".repeat(600)}1`)).toBe(1);
    expect(value(`${"-".repeat(1020)}1`)).toBe(1);
    expect(value("Minus600")).toBe(1);
    expect(value("Minus1200")).toEqual(err("#NUM!"));
  });

  it("limits the cells one evaluation reads and builds", () => {
    const { value } = setup({ maxCells: 10 });
    expect(value("SUM(A1:B3)")).toBe(66);
    expect(value("SUM(A1:B3)+SUM(A1:B3)")).toEqual(err("#NUM!"));
    expect(value("SUM(A1:C4)")).toEqual(err("#NUM!"));
    expect(value("SUM(A1:A3*{1,2,3,4})")).toEqual(err("#NUM!"));
    expect(value("SUM(DOUBLE(A1:A3*{1,2}))")).toEqual(err("#NUM!"));
    expect(value("IFERROR(SUM(A1:C4),\"too big\")")).toBe("too big");
  });

  it("rejects text longer than a cell holds", () => {
    const { value, functions } = setup();
    functions.register("LONG", () => "x".repeat(20_000));
    expect(value('LONG()&LONG()')).toEqual(err("#VALUE!"));
    expect(typeof value('LONG()&"y"')).toBe("string");
  });
});

describe("context", () => {
  it("hands the calculation context to functions", () => {
    const seen: unknown[] = [];
    const { value, functions } = setup({ now: "2024-05-01T10:00:00Z", date1904: true, random: () => 0.25, row: 4, col: 2 });
    functions.register("CTX", (_args, ctx) => {
      seen.push(ctx.sheet, ctx.row, ctx.col, ctx.now, ctx.date1904, ctx.random(), ctx.formatValue);
      return 0;
    });
    value("CTX()");
    expect(seen).toEqual(["Sheet1", 4, 2, "2024-05-01T10:00:00Z", true, 0.25, null]);
  });

  it("defaults now to null and uses the 1904 system for date text", () => {
    const { value, functions } = setup();
    functions.register("NOWIS", (_args, ctx) => ctx.now === null);
    expect(value("NOWIS()")).toBe(true);
    expect(setup({ date1904: true }).value('"1904-01-02"+0')).toBe(1);
  });
});

describe("toCellResult", () => {
  const { run } = setup();
  it("picks the value a cell shows", () => {
    expect(toCellResult(5, 0, 0)).toBe(5);
    expect(toCellResult(null, 0, 0)).toBe(0);
    expect(toCellResult("", 0, 0)).toBe("");
    expect(toCellResult(run("A2"), 7, 7)).toBe(2);
    expect(toCellResult(run("A4"), 7, 7)).toBe(0);
    expect(toCellResult(run("A1:A3"), 1, 5)).toBe(2);
    expect(toCellResult(run("A1:A3"), 7, 5)).toEqual(err("#VALUE!"));
    expect(toCellResult(run("A1:C1"), 5, 1)).toBe(10);
    expect(toCellResult(run("A1:B2"), 0, 0)).toEqual(err("#VALUE!"));
    expect(toCellResult(run("A:A"), 2, 9)).toBe(3);
    expect(toCellResult(run("A:A"), 500, 9)).toBe(0);
    expect(toCellResult(run("A1:A3*2"), 9, 9)).toBe(2);
    expect(toCellResult(makeArray([]), 0, 0)).toBe(0);
    expect(toCellResult(run("B4"), 0, 0)).toEqual(err("#DIV/0!"));
  });
});
