/**
 * Information functions: ISBLANK, ISNUMBER, ISTEXT, ISNONTEXT, ISLOGICAL,
 * ISERROR, ISERR, ISNA, ISEVEN, ISODD, NA, N, TYPE, ERROR.TYPE.
 *
 * The IS functions never return an error, except ISEVEN and ISODD, which
 * convert their argument to a number. Every function except TYPE applies
 * element by element to an array argument.
 */

import type { FormulaErrorCode, FormulaScalar, FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, cellCount, isArray, isError, toNumber, toScalar } from "../../coerce.js";
import { registerFunction } from "../../registry.js";

const ONE = { minArgs: 1, maxArgs: 1, ranges: "none" } as const;

const ERROR_NUMBERS: Readonly<Record<FormulaErrorCode, number>> = {
  "#NULL!": 1,
  "#DIV/0!": 2,
  "#VALUE!": 3,
  "#REF!": 4,
  "#NAME?": 5,
  "#NUM!": 6,
  "#N/A": 7,
};

const PREDICATES: ReadonlyArray<[string, (value: FormulaScalar) => boolean]> = [
  ["ISBLANK", (v) => v === null],
  ["ISNUMBER", (v) => typeof v === "number"],
  ["ISTEXT", (v) => typeof v === "string"],
  ["ISNONTEXT", (v) => typeof v !== "string"],
  ["ISLOGICAL", (v) => typeof v === "boolean"],
  ["ISERROR", (v) => isError(v)],
  ["ISERR", (v) => isError(v) && v.code !== "#N/A"],
  ["ISNA", (v) => isError(v) && v.code === "#N/A"],
];

/** ISEVEN and ISODD: the number is truncated; booleans and other text are `#VALUE!`. */
function parity(odd: boolean) {
  return ([value]: readonly FormulaValue[]): FormulaValue => {
    const scalar = toScalar(value ?? null);
    if (typeof scalar === "boolean") return ERR.VALUE;
    const n = toNumber(scalar);
    if (isError(n)) return n;
    const remainder = Math.abs(Math.trunc(n)) % 2;
    return odd ? remainder === 1 : remainder === 0;
  };
}

function n([value]: readonly FormulaValue[]): FormulaValue {
  const scalar = toScalar(value ?? null);
  if (typeof scalar === "number" || isError(scalar)) return scalar;
  if (typeof scalar === "boolean") return scalar ? 1 : 0;
  return 0;
}

/** TYPE: 1 number or blank, 2 text, 4 boolean, 16 error, 64 array. */
function type([value]: readonly FormulaValue[]): FormulaValue {
  const arg = value ?? null;
  if (isArray(arg) && cellCount(arg) !== 1) return 64;
  const scalar = toScalar(arg);
  if (typeof scalar === "string") return 2;
  if (typeof scalar === "boolean") return 4;
  if (isError(scalar)) return 16;
  return 1;
}

function errorType([value]: readonly FormulaValue[]): FormulaValue {
  const scalar = toScalar(value ?? null);
  return isError(scalar) ? ERROR_NUMBERS[scalar.code] : ERR.NA;
}

export function registerInformationFunctions(registry: FunctionRegistry): void {
  for (const [name, test] of PREDICATES) {
    registerFunction(registry, name, ([value]) => test(toScalar(value ?? null)), ONE);
  }
  registerFunction(registry, "ISEVEN", parity(false), ONE);
  registerFunction(registry, "ISODD", parity(true), ONE);
  registerFunction(registry, "NA", () => ERR.NA, { minArgs: 0, maxArgs: 0 });
  registerFunction(registry, "N", n, ONE);
  registerFunction(registry, "TYPE", type, { minArgs: 1, maxArgs: 1 });
  registerFunction(registry, "ERROR.TYPE", errorType, ONE);
}
