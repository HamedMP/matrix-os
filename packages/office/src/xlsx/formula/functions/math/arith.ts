/**
 * Elementary number functions: ABS, SIGN, INT, TRUNC, ROUND, ROUNDUP,
 * ROUNDDOWN, MROUND, CEILING, FLOOR (with their .MATH and .PRECISE forms),
 * MOD, QUOTIENT, POWER, SQRT, EXP, LN, LOG, LOG10, PI, RAND, RANDBETWEEN.
 *
 * Rounding works on the decimal value a spreadsheet shows, so
 * `ROUND(2.675, 2)` is 2.68 and `CEILING(0.3, 0.1)` is 0.3.
 */

import type { FunctionRegistry } from "../../../../api/formula.js";
import { ERR } from "../../coerce.js";
import { clean, registerNumeric, roundTo, type NumericResult } from "./scalar.js";

const ONE = { minArgs: 1, maxArgs: 1 } as const;
const TWO = { minArgs: 2, maxArgs: 2 } as const;

/** Rounds `value / step` with `round` and multiplies back, cleaning binary noise on both sides. */
function toMultiple(value: number, step: number, round: (q: number) => number): number {
  return clean(round(clean(value / step)) * step);
}

function halfAwayFromZero(q: number): number {
  return q < 0 ? -Math.round(-q) : Math.round(q);
}

function mround(value: number, multiple: number): NumericResult {
  if (multiple === 0 || value === 0) return 0;
  if (value * multiple < 0) return ERR.NUM;
  return toMultiple(value, multiple, halfAwayFromZero);
}

function ceiling(value: number, significance: number): NumericResult {
  if (significance === 0 || value === 0) return 0;
  if (value > 0 && significance < 0) return ERR.NUM;
  return toMultiple(value, significance, Math.ceil);
}

function floor(value: number, significance: number): NumericResult {
  if (value === 0) return 0;
  if (significance === 0) return ERR.DIV0;
  if (value > 0 && significance < 0) return ERR.NUM;
  return toMultiple(value, significance, Math.floor);
}

/** CEILING.MATH and FLOOR.MATH: the sign of significance is ignored; `mode` flips the direction for negative numbers. */
function mathRounding(up: boolean) {
  return ([value, significance, mode]: number[]): NumericResult => {
    const step = Math.abs(significance as number);
    const n = value as number;
    if (step === 0 || n === 0) return 0;
    const awayFromZero = n < 0 && mode !== 0;
    const towardPositive = awayFromZero ? !up : up;
    return toMultiple(n, step, towardPositive ? Math.ceil : Math.floor);
  };
}

function mod(n: number, d: number): NumericResult {
  if (d === 0) return ERR.DIV0;
  const r = n - d * Math.floor(n / d);
  return Math.abs(r) >= Math.abs(d) ? 0 : r;
}

function power(base: number, exponent: number): NumericResult {
  if (base === 0 && exponent === 0) return ERR.NUM;
  if (base === 0 && exponent < 0) return ERR.DIV0;
  return Math.pow(base, exponent);
}

function log(n: number, base: number): NumericResult {
  if (n <= 0 || base <= 0) return ERR.NUM;
  if (base === 1) return ERR.DIV0;
  return base === 10 ? Math.log10(n) : clean(Math.log(n) / Math.log(base));
}

export function registerArithmetic(registry: FunctionRegistry): void {
  registerNumeric(registry, "ABS", ONE, ([n]) => Math.abs(n as number));
  registerNumeric(registry, "SIGN", ONE, ([n]) => Math.sign(n as number) + 0);
  registerNumeric(registry, "INT", ONE, ([n]) => Math.floor(n as number));
  registerNumeric(registry, "TRUNC", { minArgs: 1, maxArgs: 2 }, ([n, d]) => roundTo(n as number, d as number, "down"));
  registerNumeric(registry, "ROUND", TWO, ([n, d]) => roundTo(n as number, d as number, "half"));
  registerNumeric(registry, "ROUNDUP", TWO, ([n, d]) => roundTo(n as number, d as number, "up"));
  registerNumeric(registry, "ROUNDDOWN", TWO, ([n, d]) => roundTo(n as number, d as number, "down"));
  registerNumeric(registry, "MROUND", TWO, ([n, m]) => mround(n as number, m as number));
  registerNumeric(registry, "CEILING", TWO, ([n, s]) => ceiling(n as number, s as number));
  registerNumeric(registry, "FLOOR", TWO, ([n, s]) => floor(n as number, s as number));
  const math = { minArgs: 1, maxArgs: 3, defaults: [1, 0] } as const;
  const precise = { minArgs: 1, maxArgs: 2, defaults: [1] } as const;
  registerNumeric(registry, "CEILING.MATH", math, mathRounding(true));
  registerNumeric(registry, "FLOOR.MATH", math, mathRounding(false));
  registerNumeric(registry, "CEILING.PRECISE", precise, ([n, s]) => mathRounding(true)([n as number, s as number, 0]));
  registerNumeric(registry, "ISO.CEILING", precise, ([n, s]) => mathRounding(true)([n as number, s as number, 0]));
  registerNumeric(registry, "FLOOR.PRECISE", precise, ([n, s]) => mathRounding(false)([n as number, s as number, 0]));
  registerNumeric(registry, "MOD", TWO, ([n, d]) => mod(n as number, d as number));
  registerNumeric(registry, "QUOTIENT", TWO, ([n, d]) => (d === 0 ? ERR.DIV0 : Math.trunc((n as number) / (d as number))));
  registerNumeric(registry, "POWER", TWO, ([b, e]) => power(b as number, e as number));
  registerNumeric(registry, "SQRT", ONE, ([n]) => ((n as number) < 0 ? ERR.NUM : Math.sqrt(n as number)));
  registerNumeric(registry, "EXP", ONE, ([n]) => Math.exp(n as number));
  registerNumeric(registry, "LN", ONE, ([n]) => ((n as number) <= 0 ? ERR.NUM : Math.log(n as number)));
  registerNumeric(registry, "LOG", { minArgs: 1, maxArgs: 2, defaults: [10] }, ([n, b]) => log(n as number, b as number));
  registerNumeric(registry, "LOG10", ONE, ([n]) => ((n as number) <= 0 ? ERR.NUM : Math.log10(n as number)));
  registerNumeric(registry, "PI", { minArgs: 0, maxArgs: 0 }, () => Math.PI);
  registerNumeric(registry, "RAND", { minArgs: 0, maxArgs: 0, volatile: true }, (_, context) => context.random());
  registerNumeric(registry, "RANDBETWEEN", { ...TWO, volatile: true }, ([bottom, top], context) => {
    const low = Math.ceil(bottom as number);
    const high = Math.floor(top as number);
    if (low > high) return ERR.NUM;
    return low + Math.min(high - low, Math.floor(context.random() * (high - low + 1)));
  });
}
