/**
 * Aggregates over every argument: SUM, PRODUCT, MIN, MAX, SUMPRODUCT, GCD
 * and LCM.
 *
 * A value typed directly as an argument is converted (`SUM("2", TRUE)` is
 * 3, `SUM("x")` is `#VALUE!`); text, booleans and blanks inside a range are
 * skipped; the first error is the result. Without any number, SUM, PRODUCT,
 * MIN and MAX give 0.
 */

import type { FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, collectNumbers, finiteOrError, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { maximum, minimum, product, total } from "../stat/compute.js";
import { gridOf, sameShape, usedRegion } from "../stat/grid.js";

/** Largest integer GCD and LCM work with. */
const MAX_INTEGER = 2 ** 53;

function overNumbers(fn: (numbers: readonly number[]) => number) {
  return (args: readonly FormulaValue[]): FormulaValue => {
    const numbers = collectNumbers(args);
    return isError(numbers) ? numbers : finiteOrError(fn(numbers));
  };
}

/**
 * SUMPRODUCT: multiplies the arrays element by element and adds the
 * products. Every array must have the same size (`#VALUE!` otherwise);
 * entries that are not numbers count as 0; errors propagate.
 */
function sumProduct(args: readonly FormulaValue[]): FormulaValue {
  for (const arg of args) if (isError(arg)) return arg;
  const grids = args.map((arg) => gridOf(arg ?? null));
  if (!sameShape(grids)) return ERR.VALUE;
  const region = usedRegion(grids);
  let sum = 0;
  for (let row = 0; row < region.rows; row += 1) {
    for (let col = 0; col < region.cols; col += 1) {
      let term = 1;
      for (const grid of grids) {
        const cell = grid.at(row, col);
        if (isError(cell)) return cell;
        term *= typeof cell === "number" ? cell : 0;
      }
      sum += term;
    }
  }
  return finiteOrError(sum);
}

function integers(args: readonly FormulaValue[]): number[] | FormulaValue {
  const numbers = collectNumbers(args);
  if (isError(numbers)) return numbers;
  const out: number[] = [];
  for (const n of numbers) {
    if (n < 0 || n >= MAX_INTEGER) return ERR.NUM;
    out.push(Math.trunc(n));
  }
  return out;
}

function gcdPair(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

function gcd(args: readonly FormulaValue[]): FormulaValue {
  const numbers = integers(args);
  if (!Array.isArray(numbers)) return numbers;
  return numbers.reduce(gcdPair, 0);
}

function lcm(args: readonly FormulaValue[]): FormulaValue {
  const numbers = integers(args);
  if (!Array.isArray(numbers)) return numbers;
  let result = 1;
  for (const n of numbers) {
    if (n === 0) return 0;
    result = (result / gcdPair(result, n)) * n;
    if (result >= MAX_INTEGER) return ERR.NUM;
  }
  return result;
}

export function registerAggregates(registry: FunctionRegistry): void {
  registerFunction(registry, "SUM", overNumbers(total), { minArgs: 1 });
  registerFunction(registry, "PRODUCT", overNumbers(product), { minArgs: 1 });
  registerFunction(registry, "MIN", overNumbers(minimum), { minArgs: 1 });
  registerFunction(registry, "MAX", overNumbers(maximum), { minArgs: 1 });
  registerFunction(registry, "SUMPRODUCT", sumProduct, { minArgs: 1, maxArgs: 255 });
  registerFunction(registry, "GCD", gcd, { minArgs: 1, maxArgs: 255 });
  registerFunction(registry, "LCM", lcm, { minArgs: 1, maxArgs: 255 });
}
