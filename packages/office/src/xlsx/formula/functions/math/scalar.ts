/**
 * Helpers for scalar number functions. A function registered with
 * {@link registerNumeric} receives numbers: each argument is converted with
 * the spreadsheet rules (blank is 0, `TRUE` is 1, text that reads as a
 * number counts, other text is `#VALUE!`), the first error is the result,
 * and an array argument applies the function element by element.
 */

import type { FormulaError, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { finiteOrError, isError, toNumber } from "../../coerce.js";
import { registerFunction } from "../../registry.js";

export type NumericResult = number | boolean | FormulaError;

export interface NumericSpec {
  minArgs: number;
  maxArgs: number;
  /** Values of the optional arguments (those after `minArgs`), in order, when they are not given at all. Default 0. */
  defaults?: readonly number[];
  volatile?: boolean;
}

/**
 * Registers a function of numbers. `fn` receives one number per declared
 * argument; an argument not given takes its default (an argument left
 * empty, as in `ROUND(2.5,)`, is blank and so 0).
 */
export function registerNumeric(
  registry: FunctionRegistry,
  name: string,
  spec: NumericSpec,
  fn: (numbers: number[], context: FunctionContext) => NumericResult,
): void {
  registerFunction(
    registry,
    name,
    (args: readonly FormulaValue[], context: FunctionContext) => {
      const numbers: number[] = [];
      for (let i = 0; i < spec.maxArgs; i += 1) {
        if (i >= args.length) {
          numbers.push(spec.defaults?.[i - spec.minArgs] ?? 0);
          continue;
        }
        const n = toNumber(args[i] ?? null, { date1904: context.date1904 });
        if (isError(n)) return n;
        numbers.push(n);
      }
      const result = fn(numbers, context);
      return typeof result === "number" ? finiteOrError(result) : result;
    },
    { minArgs: spec.minArgs, maxArgs: spec.maxArgs, ranges: "none", volatile: spec.volatile === true },
  );
}

/** A number cut to the 15 significant digits a spreadsheet keeps, which removes binary noise such as `0.1 + 0.2`. */
export function clean(value: number): number {
  return Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(15)) : value;
}

/** `value * 10^digits` computed on the decimal text, so that `2.675` shifted by 2 is exactly `267.5`. */
export function shiftDecimal(value: number, digits: number): number {
  const [mantissa, exponent] = String(value).split("e");
  return Number(`${mantissa}e${Number(exponent ?? 0) + digits}`);
}

export type RoundMode = "half" | "up" | "down";

/**
 * Rounds to `digits` decimal places (negative digits round to the left of
 * the point). `half` rounds halves away from zero, `up` away from zero,
 * `down` toward zero.
 */
export function roundTo(value: number, digits: number, mode: RoundMode): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const places = Math.trunc(digits);
  const magnitude = clean(Math.abs(value));
  if (places > 300) return value;
  if (places < -308) return 0;
  const scaled = shiftDecimal(magnitude, places);
  if (!Number.isFinite(scaled) || scaled >= 2 ** 52) return clean(value);
  const whole = mode === "half" ? Math.round(scaled) : mode === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  const result = whole === 0 ? 0 : shiftDecimal(whole, -places);
  return value < 0 && result !== 0 ? -result : result;
}
