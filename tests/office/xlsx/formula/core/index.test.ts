import { describe, expect, it } from "vitest";
import type { FormulaModule } from "../../../../../packages/office/src/api/formula.js";
import * as formula from "../../../../../packages/office/src/xlsx/formula/index.js";
import { makeProvider } from "./helpers.js";

describe("formula module", () => {
  it("implements the contract", () => {
    const contract: FormulaModule = formula;
    for (const name of ["parseFormula", "serializeFormula", "evaluate", "collectReferences", "mapReferences", "createFunctionRegistry"] as const) {
      expect(typeof contract[name]).toBe("function");
    }
  });

  it("creates a registry with the core functions, or an empty one", () => {
    const registry = formula.createFunctionRegistry();
    for (const name of ["SUM", "IF", "IFERROR", "AND", "OR", "NOT"]) expect(registry.has(name)).toBe(true);
    expect(registry.get("IF")).toMatchObject({ lazy: true, minArgs: 2, maxArgs: 3 });
    expect(registry.get("SUM")).toMatchObject({ lazy: false, minArgs: 1, maxArgs: null, volatile: false });
    expect(formula.createFunctionRegistry({ builtins: true }).names()).toEqual(registry.names());
    expect(formula.createFunctionRegistry({ builtins: false }).names()).toEqual([]);
  });

  it("gives each caller its own registry", () => {
    const first = formula.createFunctionRegistry();
    first.register("ONLYHERE", () => 1);
    expect(formula.createFunctionRegistry().has("ONLYHERE")).toBe(false);
  });

  it("evaluates through the contract functions alone", () => {
    const provider = makeProvider({ Sheet1: { A1: 4, A2: 6, B1: "x" } }, { Rate: { value: 0.5 } });
    const functions = formula.createFunctionRegistry();
    const context = { provider, functions, sheet: "Sheet1", row: 5, col: 5 };
    const ast = formula.parseFormula('=IF(SUM(A1:A2)*Rate>=5,"ok","low")&B1');
    expect(formula.evaluate(ast, context)).toBe("okx");
    expect(formula.serializeFormula(ast)).toBe('IF(SUM(A1:A2)*Rate>=5,"ok","low")&B1');
    expect(formula.collectReferences(ast).map((node) => node.type)).toEqual(["range", "name", "cell"]);
    const moved = formula.mapReferences(ast, (node) => (node.type === "cell" ? { ...node, row: node.row + 1 } : node));
    expect(formula.serializeFormula(moved)).toBe('IF(SUM(A1:A2)*Rate>=5,"ok","low")&B2');
  });

  it("gives the value a cell shows", () => {
    const provider = makeProvider({ Sheet1: { A1: 4, A2: 6 } });
    const functions = formula.createFunctionRegistry();
    const at = (row: number) => ({ provider, functions, sheet: "Sheet1", row, col: 3 });
    expect(formula.evaluateCell(formula.parseFormula("A2"), at(0))).toBe(6);
    expect(formula.evaluateCell(formula.parseFormula("A9"), at(0))).toBe(0);
    expect(formula.evaluateCell(formula.parseFormula("A1:A2"), at(1))).toBe(6);
    expect(formula.evaluateCell(formula.parseFormula("A1:A2"), at(5))).toMatchObject({ kind: "error", code: "#VALUE!" });
    expect(formula.evaluateCell(formula.parseFormula("A1:A2*2"), at(5))).toBe(8);
  });
});
