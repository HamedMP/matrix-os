import { expect } from "vitest";
import type {
  FormulaArray,
  FormulaError,
  FormulaScalar,
  FormulaValue,
} from "../../../../../packages/office/src/api/formula.js";
import { ERR, isArray, toNumber, toScalar } from "../../../../../packages/office/src/xlsx/formula/coerce.js";
import {
  evaluate,
  registerCoreFunctions,
  type EvaluateOptions,
} from "../../../../../packages/office/src/xlsx/formula/eval/index.js";
import { parseFormulaExtended } from "../../../../../packages/office/src/xlsx/formula/parser/index.js";
import { createRegistry, registerAll } from "../../../../../packages/office/src/xlsx/formula/registry.js";
import { makeProvider, type TestProvider } from "./helpers.js";

export const err = (code: FormulaError["code"]) => expect.objectContaining({ kind: "error", code });

function workbook(): TestProvider {
  return makeProvider(
    {
      Sheet1: {
        A1: 1, B1: 10, C1: "x",
        A2: 2, B2: 20, C2: "12",
        A3: 3, B3: 30, C3: true,
        A4: null, B4: { kind: "error", code: "#DIV/0!" }, C4: "",
        D1: "TRUE", D2: 0,
      },
      "Data 2": { A1: 100, A2: 200, B5: "end" },
      Empty: {},
    },
    {
      Rate: { value: 0.5 },
      Items: "Sheet1!$A$1:$A$3",
      First: "A1",
      Loop: "Loop+1",
      Deep1: "Deep2+1",
      Deep2: "Rate*2",
      "Data 2!Local": { value: 7 },
      Minus600: `${"-".repeat(600)}1`,
      Minus1200: `${"-".repeat(600)}Minus600`,
    },
  );
}

/** A workbook, the core functions and a few probes, with `run` (raw result) and `value` (single cells unwrapped). */
export function setup(extra: Partial<EvaluateOptions> = {}) {
  const provider = workbook();
  const functions = registerAll(createRegistry(), [registerCoreFunctions]);
  functions.register("DOUBLE", ([v]) => {
    const n = toNumber(v ?? null);
    return typeof n === "number" ? n * 2 : n;
  }, { minArgs: 1, maxArgs: 1, ranges: "none" });
  functions.register("COUNTCELLS", (args) => args.reduce<number>((n, a) => n + (isArray(a) ? a.rows * a.cols : 1), 0));
  functions.register("ISREF", ([v]) => isArray(v ?? null) && (v as FormulaArray).ref !== null, { minArgs: 1, maxArgs: 1 });
  functions.register("BOOM", () => Number.NaN);
  functions.register("THROWS", () => {
    throw new RangeError("Invalid count value");
  });
  functions.registerLazy("ROWOF", ([node], ctx) => {
    const value = ctx.evaluate(node!);
    return isArray(value) && value.ref !== null ? value.ref.startRow + 1 : ERR.VALUE;
  }, { minArgs: 1, maxArgs: 1 });
  const context: EvaluateOptions = { provider, functions, sheet: "Sheet1", row: 9, col: 9, ...extra };
  const run = (text: string, at: Partial<EvaluateOptions> = {}): FormulaValue =>
    evaluate(parseFormulaExtended(text), { ...context, ...at });
  const value = (text: string, at: Partial<EvaluateOptions> = {}): FormulaScalar => {
    const result = run(text, at);
    return isArray(result) && result.rows * result.cols === 1 ? toScalar(result) : (result as FormulaScalar);
  };
  return { provider, functions, run, value };
}
