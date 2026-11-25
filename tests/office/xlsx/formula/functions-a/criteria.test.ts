import { describe, expect, it } from "vitest";
import type { FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import { parseCriterion } from "../../../../../packages/office/src/xlsx/formula/functions/stat/criteria.js";
import { gridOf } from "../../../../../packages/office/src/xlsx/formula/functions/stat/grid.js";

const NA: FormulaScalar = { kind: "error", code: "#N/A" };
const DIV0: FormulaScalar = { kind: "error", code: "#DIV/0!" };

describe("parseCriterion", () => {
  it.each<[FormulaScalar, FormulaScalar, boolean]>([
    ["a*c", "abc", true],
    ["a*c", "ac", true],
    ["a*c", "abd", false],
    ["a*b*c", "aXbYc", true],
    ["a*b*c", "aXcYb", false],
    ["*", "", true],
    ["?", "", false],
    ["??", "ab", true],
    ["??", "abc", false],
    ["*~~", "x~", true],
    ["~*", "*", true],
    ["~*", "a", false],
    ["~x", "~x", true],
    ["AbC", "aBc", true],
    ["abc", "abcd", false],
    ["=abc", "ABC", true],
    ["<>a*", "apple", false],
    ["<>a*", 5, true],
    ["<>a*", null, true],
    ["a*", 10, false],
    ["1*", 10, false],
    [5, 5, true],
    [5, "5", true],
    [5, " 5 ", true],
    [5, true, false],
    ["5", 5, true],
    [">5", "6", false],
    [">5", 6, true],
    [">=5", 5, true],
    ["<5", -1, true],
    ["<5", null, false],
    ["<>5", null, true],
    ["<>5", "x", true],
    ["<>5", 5, false],
    [">2024-01-01", 45293, true],
    [">2024-01-01", 45292, false],
    ["50%", 0.5, true],
    [true, true, true],
    [true, 1, false],
    ["true", true, true],
    ["<>TRUE", false, true],
    [">FALSE", true, true],
    [NA, NA, true],
    [NA, DIV0, false],
    ["#DIV/0!", DIV0, true],
    ["<>#DIV/0!", DIV0, false],
    ["abc", NA, false],
    ["<>abc", NA, true],
    [null, 0, true],
    [null, null, false],
    ["", null, true],
    ["", "", true],
    ["", "x", false],
    ["=", null, true],
    ["=", "", false],
    ["<>", "", true],
    ["<>", null, false],
    [">m", "Nut", true],
    [">m", "apple", false],
    [">m", 5, false],
  ])("criterion %j on %j is %j", (criterion, cell, expected) => {
    expect(parseCriterion(criterion)(cell)).toBe(expected);
  });

  it("matches a pattern with many wildcards without blowing up", () => {
    const test = parseCriterion(`${"*a".repeat(40)}b`);
    const started = Date.now();
    expect(test("a".repeat(20_000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads dates in the 1904 system when asked", () => {
    expect(parseCriterion("=1904-01-02", { date1904: true })(1)).toBe(true);
    expect(parseCriterion("=1904-01-02")(1)).toBe(false);
  });
});

describe("gridOf", () => {
  it("keeps the full size of a clipped reference", () => {
    const grid = gridOf({
      kind: "array",
      rows: 1,
      cols: 1,
      values: [[7]],
      ref: { sheet: "S", startRow: 0, startCol: 0, endRow: 9, endCol: 1 },
    });
    expect([grid.rows, grid.cols, grid.usedRows, grid.usedCols]).toEqual([10, 2, 1, 1]);
    expect(grid.at(0, 0)).toBe(7);
    expect(grid.at(5, 1)).toBeNull();
  });
  it("treats a scalar as one cell", () => {
    const grid = gridOf("x");
    expect([grid.rows, grid.cols, grid.at(0, 0)]).toEqual([1, 1, "x"]);
  });
});
