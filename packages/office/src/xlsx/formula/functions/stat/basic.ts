/**
 * Counting and descriptive statistics: AVERAGE, AVERAGEA, COUNT, COUNTA,
 * COUNTBLANK, MEDIAN, MODE, STDEV and VAR in their sample and population
 * forms, and CORREL.
 *
 * Values typed directly as arguments are converted (`AVERAGE("2", TRUE)`
 * is 1.5); text, booleans and blanks inside a range are skipped, except by
 * AVERAGEA, which counts text as 0 and booleans as 1 or 0. Errors propagate.
 */

import type { FormulaValue, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, collectNumbers, isArray, isError, parseNumberText } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { deviation, mean, median, mode, variance, type NumberResult } from "./compute.js";
import { gridOf, type Grid } from "./grid.js";

type ListFunction = (numbers: readonly number[]) => NumberResult;

/** An aggregate over the numbers of every argument. */
function overNumbers(fn: ListFunction, inRange: "skip" | "zero" = "skip") {
  return (args: readonly FormulaValue[]): FormulaValue => {
    const numbers = collectNumbers(args, { inRange });
    return isError(numbers) ? numbers : fn(numbers);
  };
}

/** COUNT: numbers in ranges; typed arguments that are or read as numbers. Never an error. */
export function countNumbers(args: readonly FormulaValue[]): number {
  let count = 0;
  for (const arg of args) {
    if (isArray(arg)) {
      for (const row of arg.values) for (const cell of row) if (typeof cell === "number") count += 1;
    } else if (typeof arg === "number" || typeof arg === "boolean" || arg === null) {
      count += 1;
    } else if (typeof arg === "string" && parseNumberText(arg) !== null) {
      count += 1;
    }
  }
  return count;
}

/** COUNTA: cells that are not blank in ranges, and every typed argument. */
export function countValues(args: readonly FormulaValue[], skipErrors = false): number {
  let count = 0;
  for (const arg of args) {
    if (isArray(arg)) {
      for (const row of arg.values) {
        for (const cell of row) if (cell !== null && !(skipErrors && isError(cell))) count += 1;
      }
    } else if (!(skipErrors && isError(arg))) {
      count += 1;
    }
  }
  return count;
}

function countBlank(args: readonly FormulaValue[]): FormulaValue {
  const arg = args[0] ?? null;
  if (isError(arg)) return arg;
  const grid = gridOf(arg);
  let filled = 0;
  for (let row = 0; row < grid.usedRows; row += 1) {
    for (let col = 0; col < grid.usedCols; col += 1) {
      const cell = grid.at(row, col);
      if (cell !== null && cell !== "") filled += 1;
    }
  }
  return grid.rows * grid.cols - filled;
}

/** The cell at a flat, row-by-row position of a grid. */
function flatAt(grid: Grid, index: number): ReturnType<Grid["at"]> {
  return grid.at(Math.floor(index / grid.cols), index % grid.cols);
}

/** CORREL: Pearson correlation over the positions where both arrays hold numbers. */
function correl(args: readonly FormulaValue[]): FormulaValue {
  const [left, right] = [args[0] ?? null, args[1] ?? null];
  if (isError(left)) return left;
  if (isError(right)) return right;
  const a = gridOf(left);
  const b = gridOf(right);
  const size = a.rows * a.cols;
  if (size !== b.rows * b.cols) return ERR.NA;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < size; i += 1) {
    const x = flatAt(a, i);
    const y = flatAt(b, i);
    if (isError(x)) return x;
    if (isError(y)) return y;
    if (typeof x === "number" && typeof y === "number") {
      xs.push(x);
      ys.push(y);
    }
  }
  const mx = mean(xs);
  const my = mean(ys);
  if (typeof mx !== "number" || typeof my !== "number") return ERR.DIV0;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return ERR.DIV0;
  return sxy / Math.sqrt(sxx * syy);
}

export function registerBasicStatistics(registry: FunctionRegistry): void {
  registerFunction(registry, "AVERAGE", overNumbers(mean), { minArgs: 1 });
  registerFunction(registry, "AVERAGEA", overNumbers(mean, "zero"), { minArgs: 1 });
  registerFunction(registry, "COUNT", countNumbers, { minArgs: 1 });
  registerFunction(registry, "COUNTA", (args) => countValues(args), { minArgs: 1 });
  registerFunction(registry, "COUNTBLANK", countBlank, { minArgs: 1, maxArgs: 1 });
  registerFunction(registry, "MEDIAN", overNumbers(median), { minArgs: 1 });
  for (const name of ["MODE", "MODE.SNGL"]) registerFunction(registry, name, overNumbers(mode), { minArgs: 1 });
  const sample = (fn: typeof variance) => overNumbers((numbers) => fn(numbers, true));
  const population = (fn: typeof variance) => overNumbers((numbers) => fn(numbers, false));
  for (const name of ["STDEV", "STDEV.S"]) registerFunction(registry, name, sample(deviation), { minArgs: 1 });
  for (const name of ["STDEVP", "STDEV.P"]) registerFunction(registry, name, population(deviation), { minArgs: 1 });
  for (const name of ["VAR", "VAR.S"]) registerFunction(registry, name, sample(variance), { minArgs: 1 });
  for (const name of ["VARP", "VAR.P"]) registerFunction(registry, name, population(variance), { minArgs: 1 });
  registerFunction(registry, "CORREL", correl, { minArgs: 2, maxArgs: 2 });
}
