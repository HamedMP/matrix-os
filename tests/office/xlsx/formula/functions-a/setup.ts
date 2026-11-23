import { expect } from "vitest";
import type { FormulaError, FormulaScalar, FormulaValue } from "../../../../../packages/office/src/api/formula.js";
import { isArray, toScalar } from "../../../../../packages/office/src/xlsx/formula/coerce.js";
import { evaluate, type EvaluateOptions } from "../../../../../packages/office/src/xlsx/formula/eval/index.js";
import { registerA } from "../../../../../packages/office/src/xlsx/formula/functions/register-a.js";
import { parseFormulaExtended } from "../../../../../packages/office/src/xlsx/formula/parser/index.js";
import { createRegistry, registerAll } from "../../../../../packages/office/src/xlsx/formula/registry.js";
import { makeProvider } from "../core/helpers.js";

export const err = (code: FormulaError["code"]) => expect.objectContaining({ kind: "error", code });

const NA: FormulaError = { kind: "error", code: "#N/A" };

/**
 * The test sheet:
 * - A1:A5 numbers 10, 20, 30, 40, 50
 * - B1:B5 fruit names "apple", "banana", "Apple", "cherry", "apricot"
 * - C1:C5 mixed: 1, "2", TRUE, blank, 5
 * - D1:D5 numbers 3, 1, 4, 1, 5
 * - E1:E5 2, #N/A, 6, 8, 10
 * - F1:F5 text with wildcard characters: "a*", "x", "", blank, "?"
 * - G1:G3 dates 2024-01-10, 2024-02-15, 2024-03-01 as serial numbers
 * - H1:H3 "10" (text), 10, "ten"
 */
export function setup(extra: Partial<EvaluateOptions> = {}) {
  const provider = makeProvider({
    Sheet1: {
      A1: 10, A2: 20, A3: 30, A4: 40, A5: 50,
      B1: "apple", B2: "banana", B3: "Apple", B4: "cherry", B5: "apricot",
      C1: 1, C2: "2", C3: true, C4: null, C5: 5,
      D1: 3, D2: 1, D3: 4, D4: 1, D5: 5,
      E1: 2, E2: NA, E3: 6, E4: 8, E5: 10,
      F1: "a*", F2: "x", F3: "", F4: null, F5: "?",
      G1: 45301, G2: 45337, G3: 45352,
      H1: "10", H2: 10, H3: "ten",
    },
  });
  const functions = registerAll(createRegistry(), [registerA]);
  const context: EvaluateOptions = { provider, functions, sheet: "Sheet1", row: 20, col: 20, ...extra };
  const run = (text: string, at: Partial<EvaluateOptions> = {}): FormulaValue =>
    evaluate(parseFormulaExtended(text), { ...context, ...at });
  const value = (text: string, at: Partial<EvaluateOptions> = {}): FormulaScalar => {
    const result = run(text, at);
    return isArray(result) && result.rows * result.cols === 1 ? toScalar(result) : (result as FormulaScalar);
  };
  return { provider, functions, run, value };
}

export type Case = [formula: string, expected: FormulaScalar | FormulaError["code"]];

/** Checks a table of cases: an expected `#...` string is an error code, a fractional number is compared to 9 places. */
export function check(value: (text: string) => FormulaScalar, text: string, expected: Case[1]): void {
  const actual = value(text);
  if (typeof expected === "string" && expected.startsWith("#")) {
    expect(actual).toEqual(err(expected as FormulaError["code"]));
  } else if (typeof expected === "number" && !Number.isInteger(expected)) {
    expect(typeof actual).toBe("number");
    expect(actual as number).toBeCloseTo(expected, 9);
  } else {
    expect(actual).toBe(expected);
  }
}
