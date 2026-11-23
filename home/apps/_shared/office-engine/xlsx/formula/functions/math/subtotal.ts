/**
 * SUBTOTAL and AGGREGATE: one statistic chosen by number.
 *
 * SUBTOTAL(function, ref1, ...): 1 AVERAGE, 2 COUNT, 3 COUNTA, 4 MAX,
 * 5 MIN, 6 PRODUCT, 7 STDEV, 8 STDEVP, 9 SUM, 10 VAR, 11 VARP; 101 to 111
 * are the same statistics.
 *
 * AGGREGATE(function, options, ref1, ...) for functions 1 to 13 and
 * AGGREGATE(function, options, array, k) for 14 to 19: 1 AVERAGE, 2 COUNT,
 * 3 COUNTA, 4 MAX, 5 MIN, 6 PRODUCT, 7 STDEV.S, 8 STDEV.P, 9 SUM, 10 VAR.S,
 * 11 VAR.P, 12 MEDIAN, 13 MODE.SNGL, 14 LARGE, 15 SMALL, 16 PERCENTILE.INC,
 * 17 QUARTILE.INC, 18 PERCENTILE.EXC, 19 QUARTILE.EXC. Options 0 to 7;
 * options 2, 3, 6 and 7 leave error values out instead of returning them.
 *
 * Limits: the cell provider does not report hidden rows or which cells
 * hold SUBTOTAL formulas, so 101 to 111 and the hidden-row options count
 * every row, and nested subtotals are not left out.
 */

import type { FormulaError, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, collectNumbers, finiteOrError, isError, toNumber, toScalar } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { countNumbers, countValues } from "../stat/basic.js";
import {
  deviation,
  kth,
  maximum,
  mean,
  median,
  minimum,
  mode,
  percentileExclusive,
  percentileInclusive,
  product,
  quartileExclusive,
  quartileInclusive,
  total,
  variance,
  type NumberResult,
} from "../stat/compute.js";

type Statistic = (numbers: readonly number[]) => NumberResult;

/** Statistics 1 and 4 to 13; 2 (COUNT) and 3 (COUNTA) count cells instead. */
const STATISTICS: Readonly<Record<number, Statistic>> = {
  1: mean,
  4: maximum,
  5: minimum,
  6: product,
  7: (n) => deviation(n, true),
  8: (n) => deviation(n, false),
  9: total,
  10: (n) => variance(n, true),
  11: (n) => variance(n, false),
  12: median,
  13: mode,
};

/** Functions 14 to 19 of AGGREGATE, which take an array and k. */
const WITH_K: Readonly<Record<number, (numbers: readonly number[], k: number) => NumberResult>> = {
  14: (n, k) => kth(n, k, true),
  15: (n, k) => kth(n, k, false),
  16: percentileInclusive,
  17: quartileInclusive,
  18: percentileExclusive,
  19: quartileExclusive,
};

function numberArg(value: FormulaValue | undefined, context: FunctionContext): number | FormulaError {
  const n = toNumber(toScalar(value ?? null), { date1904: context.date1904 });
  return isError(n) ? n : Math.trunc(n);
}

function statistic(code: number, refs: readonly FormulaValue[], skipErrors: boolean): FormulaValue {
  if (code === 2) {
    const failed = skipErrors ? undefined : refs.find(isError);
    return failed !== undefined && isError(failed) ? failed : countNumbers(refs);
  }
  if (code === 3) return countValues(refs, skipErrors);
  const fn = STATISTICS[code];
  if (fn === undefined) return ERR.VALUE;
  const numbers = collectNumbers(refs, { direct: "skip", errors: skipErrors ? "skip" : "propagate" });
  if (isError(numbers)) return numbers;
  const result = fn(numbers);
  return typeof result === "number" ? finiteOrError(result) : result;
}

function subtotal(args: readonly FormulaValue[], context: FunctionContext): FormulaValue {
  const code = numberArg(args[0], context);
  if (isError(code)) return code;
  const base = code > 100 ? code - 100 : code;
  if (base < 1 || base > 11) return ERR.VALUE;
  return statistic(base, args.slice(1), false);
}

function aggregate(args: readonly FormulaValue[], context: FunctionContext): FormulaValue {
  const code = numberArg(args[0], context);
  if (isError(code)) return code;
  const options = numberArg(args[1], context);
  if (isError(options)) return options;
  if (options < 0 || options > 7 || code < 1 || code > 19) return ERR.VALUE;
  const skipErrors = options === 2 || options === 3 || options === 6 || options === 7;
  const withK = WITH_K[code];
  if (withK === undefined) return statistic(code, args.slice(2), skipErrors);
  if (args.length < 4) return ERR.VALUE;
  const array = args[2] ?? null;
  if (isError(array) && !skipErrors) return array;
  const numbers = isError(array) ? [] : collectNumbers([array], { errors: skipErrors ? "skip" : "propagate" });
  if (isError(numbers)) return numbers;
  const k = toNumber(toScalar(args[3] ?? null), { date1904: context.date1904 });
  if (isError(k)) return k;
  const result = withK(numbers, k);
  return typeof result === "number" ? finiteOrError(result) : result;
}

export function registerSubtotals(registry: FunctionRegistry): void {
  registerFunction(registry, "SUBTOTAL", subtotal, { minArgs: 2, maxArgs: 255, ranges: (i) => i > 0 });
  registerFunction(registry, "AGGREGATE", aggregate, { minArgs: 3, maxArgs: 255, ranges: (i) => i > 1 });
}
