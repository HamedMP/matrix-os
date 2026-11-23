import { expect } from "vitest";
import type { FormulaArray, FormulaError, FormulaScalar, FormulaValue } from "../../../../../packages/office/src/api/formula.js";
import { isArray, toScalar } from "../../../../../packages/office/src/xlsx/formula/coerce.js";
import { evaluate, registerCoreFunctions, type EvaluateOptions } from "../../../../../packages/office/src/xlsx/formula/eval/index.js";
import { registerB } from "../../../../../packages/office/src/xlsx/formula/functions/register-b.js";
import { parseFormulaExtended } from "../../../../../packages/office/src/xlsx/formula/parser/index.js";
import { createRegistry, registerAll } from "../../../../../packages/office/src/xlsx/formula/registry.js";
import { makeProvider, type SheetData } from "../core/helpers.js";

export const err = (code: FormulaError["code"]) => expect.objectContaining({ kind: "error", code });

/** Sheet1 holds a small price table, Dates holds date-shaped data. */
const DEFAULT_SHEETS: Record<string, SheetData> = {
  Sheet1: {
    // A1:C5: a table sorted by A.
    A1: 1, B1: "apple", C1: 0.5,
    A2: 2, B2: "Banana", C2: 0.25,
    A3: 3, B3: "cherry", C3: 3,
    A4: 5, B4: "date", C4: 1.75,
    A5: 8, B5: "elder", C5: 2,
    // E1:I2: a horizontal table.
    E1: "x", F1: "y", G1: "z",
    E2: 10, F2: 20, G2: 30,
    D7: null,
    // Holidays, flags, cash flows.
    H1: 45293, H2: 45307,
    K1: -70000, K2: 12000, K3: 15000, K4: 18000, K5: 21000, K6: 26000,
    L1: "A1", L2: "Other!B2", L3: "Nope!A1", L4: "not a ref",
  },
  Other: { A1: "o-a1", B2: 42 },
};

export function setup(extra: Partial<EvaluateOptions> = {}, sheets: Record<string, SheetData> = DEFAULT_SHEETS) {
  const provider = makeProvider(sheets, { Prices: "Sheet1!$C$1:$C$5" });
  const functions = registerAll(createRegistry(), [registerCoreFunctions, registerB]);
  const context: EvaluateOptions = {
    provider,
    functions,
    sheet: "Sheet1",
    row: 9,
    col: 9,
    now: "2026-11-23T14:30:00",
    ...extra,
  };
  const run = (text: string, at: Partial<EvaluateOptions> = {}): FormulaValue =>
    evaluate(parseFormulaExtended(text), { ...context, ...at });
  /** The result, with a one-cell array unwrapped to its value. */
  const value = (text: string, at: Partial<EvaluateOptions> = {}): FormulaScalar => {
    const result = run(text, at);
    return isArray(result) && result.rows * result.cols === 1 ? toScalar(result) : (result as FormulaScalar);
  };
  /** The rows of an array result. */
  const rows = (text: string, at: Partial<EvaluateOptions> = {}): FormulaScalar[][] => {
    const result = run(text, at);
    if (!isArray(result)) throw new Error(`expected an array from ${text}, got ${JSON.stringify(result)}`);
    return (result as FormulaArray).values;
  };
  return { provider, functions, run, value, rows };
}
