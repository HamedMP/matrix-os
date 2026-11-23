/**
 * Trigonometric and hyperbolic functions, angles in radians: SIN, COS, TAN,
 * COT, SEC, CSC, ASIN, ACOS, ATAN, ATAN2, ACOT, SINH, COSH, TANH, COTH,
 * SECH, CSCH, ASINH, ACOSH, ATANH, ACOTH, DEGREES, RADIANS.
 *
 * Out-of-domain input is `#NUM!`, a pole (`COT(0)`) is `#DIV/0!`, and the
 * circular functions refuse angles of 2^27 or more, as spreadsheets do.
 */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { ERR } from "../../coerce.js";
import { registerNumeric, type NumericResult } from "./scalar.js";

/** Largest angle the circular functions accept, exclusive. */
const MAX_ANGLE = 2 ** 27;

function circular(fn: (x: number) => number) {
  return ([x]: number[]): NumericResult => (Math.abs(x as number) >= MAX_ANGLE ? ERR.NUM : fn(x as number));
}

function reciprocal(fn: (x: number) => number, maxAngle = true) {
  return ([x]: number[]): NumericResult => {
    const n = x as number;
    if (maxAngle && Math.abs(n) >= MAX_ANGLE) return ERR.NUM;
    if (n === 0) return ERR.DIV0;
    return 1 / fn(n);
  };
}

const UNARY: ReadonlyArray<[string, (numbers: number[]) => NumericResult]> = [
  ["SIN", circular(Math.sin)],
  ["COS", circular(Math.cos)],
  ["TAN", circular(Math.tan)],
  ["COT", reciprocal(Math.tan)],
  ["CSC", reciprocal(Math.sin)],
  ["SEC", circular((x) => 1 / Math.cos(x))],
  ["ASIN", ([x]) => Math.asin(x as number)],
  ["ACOS", ([x]) => Math.acos(x as number)],
  ["ATAN", ([x]) => Math.atan(x as number)],
  ["ACOT", ([x]) => Math.PI / 2 - Math.atan(x as number)],
  ["SINH", ([x]) => Math.sinh(x as number)],
  ["COSH", ([x]) => Math.cosh(x as number)],
  ["TANH", ([x]) => Math.tanh(x as number)],
  ["COTH", reciprocal(Math.tanh, false)],
  ["CSCH", reciprocal(Math.sinh, false)],
  ["SECH", ([x]) => 1 / Math.cosh(x as number)],
  ["ASINH", ([x]) => Math.asinh(x as number)],
  ["ACOSH", ([x]) => Math.acosh(x as number)],
  ["ATANH", ([x]) => Math.atanh(x as number)],
  ["ACOTH", ([x]) => (Math.abs(x as number) <= 1 ? ERR.NUM : Math.atanh(1 / (x as number)))],
  ["DEGREES", ([x]) => ((x as number) * 180) / Math.PI],
  ["RADIANS", ([x]) => ((x as number) * Math.PI) / 180],
];

export function registerTrigonometry(registry: FunctionRegistry): void {
  for (const [name, fn] of UNARY) registerNumeric(registry, name, { minArgs: 1, maxArgs: 1 }, fn);
  registerNumeric(registry, "ATAN2", { minArgs: 2, maxArgs: 2 }, ([x, y]) =>
    x === 0 && y === 0 ? ERR.DIV0 : Math.atan2(y as number, x as number),
  );
}
