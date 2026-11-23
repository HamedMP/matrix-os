import { describe, expect, it } from "vitest";
import type { FormulaError, FormulaScalar, NameResolution } from "../../../../../packages/office/src/api/formula.js";
import {
  CIRCULAR_REFERENCE,
  DependencyGraph,
  createFunctionRegistry,
  evaluateCell,
  parseFormula,
  parseFormulaExtended,
  type CellRef,
  type ExtendedAst,
  type GraphRecalcOptions,
} from "../../../../../packages/office/src/xlsx/formula/index.js";
import { address, makeProvider } from "./helpers.js";

const err = (code: FormulaError["code"]) => expect.objectContaining({ kind: "error", code });
const label = (cell: CellRef) => `${cell.sheet}!${String.fromCharCode(65 + cell.col)}${cell.row + 1}`;

/** A small workbook: values in a provider, formulas in the graph, one clock for the volatile function. */
function book(sheets: string[] = ["S"], names: Record<string, string> = {}) {
  const provider = makeProvider(Object.fromEntries(sheets.map((s) => [s, {}])), names, sheets[0]);
  const functions = createFunctionRegistry();
  let ticks = 0;
  functions.register("TICK", () => (ticks += 1), { maxArgs: 0, volatile: true });
  const formulas = new Map<string, ExtendedAst>();
  const definitions = names;
  const graph = new DependencyGraph({
    functions,
    sheetNames: () => sheets,
    resolveName: (name): NameResolution | null => {
      const text = definitions[name.toUpperCase()] ?? definitions[name];
      return text === undefined ? null : { kind: "formula", ast: parseFormula(text), sheet: sheets[0] as string };
    },
  });
  const id = (sheet: string, a1: string) => `${sheet.toUpperCase()}!${a1}`;
  const computed: string[] = [];
  return {
    graph,
    provider,
    computed,
    definitions,
    value(a1: string, sheet = sheets[0] as string) {
      return provider.get(sheet, a1);
    },
    set(a1: string, value: FormulaScalar, sheet = sheets[0] as string) {
      const { row, col } = address(a1);
      formulas.delete(id(sheet, a1));
      graph.setFormula(sheet, row, col, null);
      provider.set(sheet, a1, value);
    },
    formula(a1: string, text: string, sheet = sheets[0] as string, options?: { dirty?: boolean }) {
      const { row, col } = address(a1);
      const ast = parseFormulaExtended(text);
      formulas.set(id(sheet, a1), ast);
      graph.setFormula(sheet, row, col, ast, options);
    },
    recalc(options?: GraphRecalcOptions) {
      computed.length = 0;
      return graph.recalculate(
        {
          compute: (cell) => {
            const a1 = `${String.fromCharCode(65 + cell.col)}${cell.row + 1}`;
            const ast = formulas.get(id(cell.sheet, a1)) as ExtendedAst;
            const before = provider.get(cell.sheet, a1);
            const after = evaluateCell(ast, { provider, functions, sheet: cell.sheet, row: cell.row, col: cell.col, sheetNames: () => sheets });
            provider.set(cell.sheet, a1, after);
            computed.push(label(cell));
            return JSON.stringify(before) !== JSON.stringify(after);
          },
          circular: (cell) => {
            provider.set(cell.sheet, `${String.fromCharCode(65 + cell.col)}${cell.row + 1}`, CIRCULAR_REFERENCE);
          },
        },
        options,
      );
    },
  };
}

describe("recalculation order", () => {
  it("calculates precedents before dependents", () => {
    const b = book();
    b.formula("D1", "C1*2");
    b.formula("C1", "B1+1");
    b.formula("B1", "A1+1");
    b.set("A1", 1);
    const result = b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!C1", "S!D1"]);
    expect([b.value("B1"), b.value("C1"), b.value("D1")]).toEqual([2, 3, 6]);
    expect(result).toEqual({ computed: 3, skipped: 0, circular: [], complete: true, remaining: 0 });
  });

  it("calculates a cell once however many paths lead to it", () => {
    const b = book();
    b.set("A1", 2);
    b.formula("B1", "A1+1");
    b.formula("C1", "A1*10");
    b.formula("D1", "B1+C1");
    b.formula("E1", "D1+B1+A1");
    b.recalc();
    expect(b.computed.slice().sort()).toEqual(["S!B1", "S!C1", "S!D1", "S!E1"]);
    expect(b.computed.indexOf("S!D1")).toBeGreaterThan(b.computed.indexOf("S!B1"));
    expect(b.computed.indexOf("S!D1")).toBeGreaterThan(b.computed.indexOf("S!C1"));
    expect(b.computed.indexOf("S!E1")).toBeGreaterThan(b.computed.indexOf("S!D1"));
    expect(b.value("E1")).toBe(28);
  });

  it("follows ranges, whole columns and other sheets", () => {
    const b = book(["S", "Data"]);
    b.set("A1", 1, "Data");
    b.set("A2", 2, "Data");
    b.formula("B1", "SUM(Data!A1:A5)");
    b.formula("B2", "SUM(data!A:A)+B1");
    b.formula("B3", "S!B2*2", "Data");
    b.recalc();
    expect(b.value("B1")).toBe(3);
    expect(b.value("B2")).toBe(6);
    expect(b.value("B3", "Data")).toBe(12);
    b.set("A4", 10, "DATA");
    b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!B2", "Data!B3"]);
    expect(b.value("B3", "Data")).toBe(52);
  });

  it("handles a chain of 20 000 cells without recursion", () => {
    const graph = new DependencyGraph();
    const count = 20_000;
    for (let row = count - 1; row >= 1; row -= 1) {
      graph.setFormula("S", row, 0, { type: "cell", sheet: null, row: row - 1, col: 0, rowAbsolute: false, colAbsolute: false }, { dirty: false });
    }
    graph.markDirty("S", 0, 0);
    const rows: number[] = [];
    const result = graph.recalculate({ compute: (cell) => void rows.push(cell.row), circular: () => undefined });
    expect(result.computed).toBe(count - 1);
    expect(rows[0]).toBe(1);
    expect(rows[rows.length - 1]).toBe(count - 1);
    expect(rows.every((row, i) => row === i + 1)).toBe(true);
  });
});

describe("dirty propagation", () => {
  it("recalculates only what reads the changed cell", () => {
    const b = book();
    b.set("A1", 1);
    b.set("A2", 5);
    b.formula("B1", "A1+1");
    b.formula("B2", "A2+1");
    b.formula("C1", "B1+B2");
    b.formula("C2", "B2*2");
    b.recalc();
    expect(b.computed.length).toBe(4);
    expect(b.graph.hasDirty).toBe(false);
    expect(b.recalc().computed).toBe(0);
    b.set("A1", 10);
    expect(b.graph.hasDirty).toBe(true);
    b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!C1"]);
    expect(b.value("C1")).toBe(17);
  });

  it("skips formulas whose precedents did not change", () => {
    const b = book();
    b.set("A1", 5);
    b.formula("B1", "A1>3");
    b.formula("C1", "IF(B1,\"big\",\"small\")");
    b.formula("D1", 'C1&"!"');
    b.recalc();
    b.set("A1", 9);
    const result = b.recalc();
    expect(b.computed).toEqual(["S!B1"]);
    expect(result).toMatchObject({ computed: 1, skipped: 2, complete: true });
    b.set("A1", 1);
    b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!C1", "S!D1"]);
    expect(b.value("D1")).toBe("small!");
  });

  it("follows a changed formula and forgets its old precedents", () => {
    const b = book();
    b.set("A1", 1);
    b.set("A2", 2);
    b.formula("B1", "A1*10");
    b.formula("C1", "B1+1");
    b.recalc();
    b.formula("B1", "A2*10");
    b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!C1"]);
    expect(b.value("C1")).toBe(21);
    b.set("A1", 100);
    expect(b.recalc().computed).toBe(0);
    b.set("A2", 3);
    b.recalc();
    expect(b.value("C1")).toBe(31);
  });

  it("recalculates dependents when a formula is replaced by a value or removed", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "A1+1");
    b.formula("C1", "B1+1");
    b.recalc();
    b.set("B1", 50);
    b.recalc();
    expect(b.computed).toEqual(["S!C1"]);
    expect(b.value("C1")).toBe(51);
    expect(b.graph.hasFormula("S", 0, 1)).toBe(false);
    expect(b.graph.removeFormula("S", 0, 2)).toBe(true);
    expect(b.graph.removeFormula("S", 0, 2)).toBe(false);
    expect(b.graph.formulaCount).toBe(0);
  });

  it("does not mark a loaded formula out of date", () => {
    const b = book();
    b.set("A1", 1);
    b.recalc();
    b.formula("B1", "A1+1", "S", { dirty: false });
    expect(b.recalc().computed).toBe(0);
    expect(b.value("B1")).toBeNull();
    b.graph.markDirty("S", 0, 1);
    expect(b.recalc().computed).toBe(1);
    b.graph.markAllDirty();
    expect(b.recalc().computed).toBe(1);
  });

  it("marks everything that reads a rectangle", () => {
    const b = book();
    b.formula("D1", "A1+1");
    b.formula("D2", "SUM(A1:B3)");
    b.formula("D3", "SUM(B:B)");
    b.formula("D4", "C9+1");
    b.formula("A2", "5");
    b.recalc();
    b.graph.markRangeDirty({ sheet: "s", startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    b.recalc();
    expect(b.computed.slice().sort()).toEqual(["S!A2", "S!D1", "S!D2", "S!D3"]);
  });

  it("keeps the marks when a handler throws", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "A1+1");
    expect(() =>
      b.graph.recalculate({
        compute: () => {
          throw new Error("store failed");
        },
        circular: () => undefined,
      }),
    ).toThrowError("store failed");
    expect(b.graph.hasDirty).toBe(true);
    expect(b.recalc().computed).toBe(1);
  });
});

describe("defined names", () => {
  it("reads through a name to the cells it stands for", () => {
    const b = book(["S"], { RATE: "S!$A$1", TOTAL: "SUM(S!$B$1:$B$3)*RATE" });
    b.set("A1", 2);
    b.set("B2", 5);
    b.formula("C1", "Total+1");
    b.recalc();
    expect(b.value("C1")).toBe(11);
    b.set("A1", 3);
    b.recalc();
    expect(b.computed).toEqual(["S!C1"]);
    expect(b.value("C1")).toBe(16);
    b.set("B3", 1);
    b.recalc();
    expect(b.value("C1")).toBe(19);
    expect(b.graph.precedents("S", 0, 2)).toEqual([
      { kind: "name", name: "Total" },
      { kind: "range", bounds: { sheet: "S", startRow: 0, startCol: 1, endRow: 2, endCol: 1 } },
      { kind: "name", name: "RATE" },
      { kind: "cell", sheet: "S", row: 0, col: 0 },
    ]);
  });

  it("reads the precedents again when a name changes", () => {
    const b = book(["S"], { RATE: "S!$A$1" });
    b.set("A1", 2);
    b.set("A2", 7);
    b.formula("C1", "rate*10");
    b.recalc();
    expect(b.value("C1")).toBe(20);
    b.definitions.RATE = "S!$A$2";
    b.graph.markNameDirty("Rate");
    b.recalc();
    expect(b.value("C1")).toBe(70);
    b.set("A1", 99);
    expect(b.recalc().computed).toBe(0);
    b.set("A2", 8);
    b.recalc();
    expect(b.value("C1")).toBe(80);
  });

  it("survives a name that refers to itself", () => {
    const b = book(["S"], { LOOP: "LOOP+1" });
    b.formula("A1", "Loop");
    b.recalc();
    expect(b.value("A1")).toEqual(err("#NUM!"));
  });
});

describe("circular references", () => {
  it("gives the cells of a circle the circular-reference error and calculates the rest", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "C1+A1");
    b.formula("C1", "D1+1");
    b.formula("D1", "B1+1");
    b.formula("E1", "D1+1");
    b.formula("F1", "A1+1");
    const result = b.recalc();
    expect(result.circular.map(label).sort()).toEqual(["S!B1", "S!C1", "S!D1"]);
    expect(b.value("B1")).toEqual(CIRCULAR_REFERENCE);
    expect(b.value("D1")).toEqual(err("#REF!"));
    expect(b.value("E1")).toEqual(err("#REF!"));
    expect(b.value("F1")).toBe(2);
    expect(b.computed.slice().sort()).toEqual(["S!E1", "S!F1"]);
  });

  it("detects a cell that reads itself, directly or through a range", () => {
    const b = book();
    b.formula("A1", "A1+1");
    b.formula("B3", "SUM(B1:B5)");
    b.formula("C1", "SUM(C:C)");
    b.formula("D1", "1+1");
    const result = b.recalc();
    expect(result.circular.map(label).sort()).toEqual(["S!A1", "S!B3", "S!C1"]);
    expect(b.value("D1")).toBe(2);
  });

  it("recovers when the circle is broken", () => {
    const b = book();
    b.formula("A1", "B1+1");
    b.formula("B1", "A1+1");
    b.formula("C1", "B1*2");
    expect(b.recalc().circular.length).toBe(2);
    b.formula("A1", "5");
    const result = b.recalc();
    expect(result.circular).toEqual([]);
    expect([b.value("A1"), b.value("B1"), b.value("C1")]).toEqual([5, 6, 12]);
  });

  it("plans the same order without calculating", () => {
    const b = book();
    b.formula("A1", "B1");
    b.formula("B1", "A1");
    b.formula("C1", "7");
    const plan = b.graph.plan();
    expect(plan.complete).toBe(true);
    expect(plan.steps.map((s) => `${label(s)}${s.circular ? "*" : ""}`).sort()).toEqual(["S!A1*", "S!B1*", "S!C1"]);
    expect(b.graph.hasDirty).toBe(true);
  });
});

describe("volatile functions", () => {
  it("recalculates a volatile formula and its dependents on every run", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "TICK()");
    b.formula("C1", "B1*10");
    b.formula("D1", "A1+1");
    b.recalc();
    expect(b.graph.isVolatile("S", 0, 1)).toBe(true);
    expect(b.graph.isVolatile("S", 0, 2)).toBe(false);
    expect(b.value("C1")).toBe(10);
    b.recalc();
    expect(b.computed).toEqual(["S!B1", "S!C1"]);
    expect(b.value("C1")).toBe(20);
    expect(b.recalc({ volatile: false }).computed).toBe(0);
    expect(b.value("C1")).toBe(20);
  });

  it("stops treating a cell as volatile when its formula changes", () => {
    const b = book();
    b.formula("B1", "IF(TRUE,1,TICK())");
    b.recalc();
    expect(b.recalc().computed).toBe(1);
    b.formula("B1", "1");
    b.recalc();
    expect(b.recalc().computed).toBe(0);
  });

  it("treats a reference across sheets as precedents on every sheet of the span", () => {
    const b = book(["S", "Jan", "Feb", "Mar"]);
    b.set("A1", 1, "Jan");
    b.set("A1", 2, "Feb");
    b.set("A1", 3, "Mar");
    b.formula("A1", "SUM(Jan:Mar!A1)");
    b.recalc();
    expect(b.value("A1")).toBe(6);
    expect(b.graph.isVolatile("S", 0, 0)).toBe(false);
    b.set("A1", 20, "Feb");
    b.recalc();
    expect(b.value("A1")).toBe(24);
    const unknown = new DependencyGraph();
    unknown.setFormula("S", 0, 0, parseFormulaExtended("SUM(Jan:Mar!A1)"));
    expect(unknown.isVolatile("S", 0, 0)).toBe(true);
  });
});

describe("limits", () => {
  it("stops at maxCells and continues on the next run", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "A1+1");
    b.formula("C1", "B1+1");
    b.formula("D1", "C1+1");
    b.formula("E1", "D1+1");
    const first = b.recalc({ maxCells: 2 });
    expect(first).toMatchObject({ computed: 2, complete: false, remaining: 2 });
    expect(b.computed).toEqual(["S!B1", "S!C1"]);
    expect(b.value("E1")).toBeNull();
    const second = b.recalc({ maxCells: 2 });
    expect(second).toMatchObject({ computed: 2, complete: true, remaining: 0 });
    expect(b.value("E1")).toBe(5);
  });

  it("stops at maxDepth", () => {
    const b = book();
    b.set("A1", 1);
    b.formula("B1", "A1+1");
    b.formula("C1", "B1+1");
    b.formula("D1", "C1+1");
    const result = b.recalc({ maxDepth: 2 });
    expect(result).toMatchObject({ computed: 2, complete: false, remaining: 1 });
    expect(b.graph.plan({ maxDepth: 2 })).toMatchObject({ complete: true });
    expect(b.recalc().computed).toBe(1);
    expect(b.value("D1")).toBe(4);
  });
});

describe("precedents and dependents", () => {
  it("lists what a formula reads", () => {
    const graph = new DependencyGraph();
    graph.setFormula("S", 4, 4, parseFormula("A1+SUM(B1:B3,Other!C:C)+A1+Rate+$A$1"));
    expect(graph.precedents("S", 4, 4)).toEqual([
      { kind: "cell", sheet: "S", row: 0, col: 0 },
      { kind: "range", bounds: { sheet: "S", startRow: 0, startCol: 1, endRow: 2, endCol: 1 } },
      { kind: "range", bounds: { sheet: "Other", startRow: 0, startCol: 2, endRow: 1_048_575, endCol: 2 } },
      { kind: "name", name: "Rate" },
    ]);
    expect(graph.precedents("S", 0, 0)).toEqual([]);
  });

  it("lists the formulas that read a cell directly", () => {
    const graph = new DependencyGraph();
    graph.setFormula("S", 9, 0, parseFormula("B2"));
    graph.setFormula("S", 5, 3, parseFormula("SUM(A1:C3)"));
    graph.setFormula("Other", 0, 0, parseFormula("s!B:B"));
    graph.setFormula("S", 7, 7, parseFormula("A10"));
    expect(graph.dependents("S", 1, 1)).toEqual([
      { sheet: "Other", row: 0, col: 0 },
      { sheet: "S", row: 5, col: 3 },
      { sheet: "S", row: 9, col: 0 },
    ]);
    expect(graph.dependents("S", 9, 0)).toEqual([{ sheet: "S", row: 7, col: 7 }]);
    expect(graph.dependents("S", 50, 50)).toEqual([]);
    expect(graph.dependents("Nowhere", 0, 0)).toEqual([]);
    graph.clear();
    expect(graph.formulaCount).toBe(0);
    expect(graph.dependents("S", 1, 1)).toEqual([]);
  });
});

describe("replacing a formula", () => {
  it("keeps one node per cell", () => {
    const graph = new DependencyGraph();
    graph.setFormula("S", 0, 0, parseFormula("B1"));
    graph.setFormula("s", 0, 0, parseFormula("C1"));
    expect(graph.formulaCount).toBe(1);
    expect(graph.dependents("S", 0, 1)).toEqual([]);
    expect(graph.dependents("S", 0, 2)).toEqual([{ sheet: "S", row: 0, col: 0 }]);
  });
});
