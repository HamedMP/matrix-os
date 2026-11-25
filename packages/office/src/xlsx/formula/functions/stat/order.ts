/**
 * Order statistics: LARGE, SMALL, RANK (.EQ and .AVG), PERCENTILE and
 * QUARTILE (inclusive and exclusive forms). The first argument is a range
 * or array whose text, booleans and blanks are skipped; the others are
 * scalars, and an array there gives an array of results.
 */

import type { FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, collectNumbers, compareValues, isError, toNumber } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import {
  kth,
  percentileExclusive,
  percentileInclusive,
  quartileExclusive,
  quartileInclusive,
  type NumberResult,
} from "./compute.js";

type Selector = (numbers: readonly number[], k: number) => NumberResult;

/** `(array, k)` where `k` is a number. */
function withK(select: Selector) {
  return (args: readonly FormulaValue[], context: FunctionContext): FormulaValue => {
    const numbers = collectNumbers([args[0] ?? null]);
    if (isError(numbers)) return numbers;
    const k = toNumber(args[1] ?? null, { date1904: context.date1904 });
    return isError(k) ? k : select(numbers, k);
  };
}

/** RANK.EQ (`average` false) and RANK.AVG: position of a number in a list, largest first unless `order` is not 0. */
function rank(average: boolean) {
  return (args: readonly FormulaValue[], context: FunctionContext): FormulaValue => {
    const value = toNumber(args[0] ?? null, { date1904: context.date1904 });
    if (isError(value)) return value;
    const ref = args[1] ?? null;
    if (isError(ref)) return ref;
    const numbers = collectNumbers([ref], { direct: "skip" });
    if (isError(numbers)) return numbers;
    const order = args.length > 2 ? toNumber(args[2] ?? null) : 0;
    if (isError(order)) return order;
    const ascending = order !== 0;
    let before = 0;
    let ties = 0;
    for (const n of numbers) {
      const c = compareValues(n, value);
      if (c === 0) ties += 1;
      else if (ascending ? c < 0 : c > 0) before += 1;
    }
    if (ties === 0) return ERR.NA;
    return average ? before + (ties + 1) / 2 : before + 1;
  };
}

export function registerOrderStatistics(registry: FunctionRegistry): void {
  const k = { minArgs: 2, maxArgs: 2, ranges: [0] } as const;
  registerFunction(registry, "LARGE", withK((numbers, n) => kth(numbers, n, true)), k);
  registerFunction(registry, "SMALL", withK((numbers, n) => kth(numbers, n, false)), k);
  for (const name of ["PERCENTILE", "PERCENTILE.INC"]) registerFunction(registry, name, withK(percentileInclusive), k);
  registerFunction(registry, "PERCENTILE.EXC", withK(percentileExclusive), k);
  for (const name of ["QUARTILE", "QUARTILE.INC"]) registerFunction(registry, name, withK(quartileInclusive), k);
  registerFunction(registry, "QUARTILE.EXC", withK(quartileExclusive), k);
  const ranked = { minArgs: 2, maxArgs: 3, ranges: [1] } as const;
  for (const name of ["RANK", "RANK.EQ"]) registerFunction(registry, name, rank(false), ranked);
  registerFunction(registry, "RANK.AVG", rank(true), ranked);
}
