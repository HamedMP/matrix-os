/**
 * Pure statistics over lists of numbers, shared by the statistical
 * functions, SUBTOTAL and AGGREGATE. Nothing here throws: a calculation that
 * has no answer returns the error value a spreadsheet shows for it.
 */

import type { FormulaError } from "../../../../api/formula.js";
import { ERR } from "../../coerce.js";

export type NumberResult = number | FormulaError;

export function total(numbers: readonly number[]): number {
  let sum = 0;
  for (const n of numbers) sum += n;
  return sum;
}

/** Arithmetic mean; `#DIV/0!` for an empty list. */
export function mean(numbers: readonly number[]): NumberResult {
  return numbers.length === 0 ? ERR.DIV0 : total(numbers) / numbers.length;
}

/**
 * Variance with two passes for accuracy. `sample` divides by n - 1 (VAR.S),
 * otherwise by n (VAR.P). `#DIV/0!` when there are too few numbers.
 */
export function variance(numbers: readonly number[], sample: boolean): NumberResult {
  const n = numbers.length;
  if (n === 0 || (sample && n < 2)) return ERR.DIV0;
  const average = total(numbers) / n;
  let squares = 0;
  for (const x of numbers) squares += (x - average) * (x - average);
  return squares / (sample ? n - 1 : n);
}

export function deviation(numbers: readonly number[], sample: boolean): NumberResult {
  const v = variance(numbers, sample);
  return typeof v === "number" ? Math.sqrt(v) : v;
}

/**
 * Sorted copies by list. A function called once per element of an array
 * argument (`SMALL(A:A,ROW(A:A))`) is handed the same list every time, which
 * is then sorted once. Entries go away with their lists.
 */
const sortedLists = new WeakMap<readonly number[], readonly number[]>();

/** The numbers in ascending order. The result is shared: read it, do not change it. */
function sorted(numbers: readonly number[]): readonly number[] {
  let list = sortedLists.get(numbers);
  if (list === undefined) {
    list = [...numbers].sort((a, b) => a - b);
    sortedLists.set(numbers, list);
  }
  return list;
}

/** Median; `#NUM!` for an empty list. */
export function median(numbers: readonly number[]): NumberResult {
  if (numbers.length === 0) return ERR.NUM;
  const list = sorted(numbers);
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 1
    ? (list[middle] as number)
    : ((list[middle - 1] as number) + (list[middle] as number)) / 2;
}

/**
 * The most frequent number. Among numbers seen equally often, the one that
 * appears first in the list wins. `#N/A` when no number repeats.
 */
export function mode(numbers: readonly number[]): NumberResult {
  const list = sorted(numbers);
  // Walking the sorted list counts each distinct value once: `runs[i]` is the length of the run starting at `i`.
  const runs = new Array<number>(list.length).fill(0);
  for (let start = 0; start < list.length; ) {
    let end = start + 1;
    while (end < list.length && list[end] === list[start]) end += 1;
    runs[start] = end - start;
    start = end;
  }
  const frequency = (x: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((list[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return runs[lo] ?? 0;
  };
  let best: number | null = null;
  let bestCount = 1;
  for (const x of numbers) {
    const count = frequency(x);
    if (count > bestCount) {
      best = x;
      bestCount = count;
    }
  }
  return best === null ? ERR.NA : best;
}

/**
 * The k-th largest (or smallest) number. `k` is rounded up to a whole
 * number; `#NUM!` when it is below 1 or above the count.
 */
export function kth(numbers: readonly number[], k: number, largest: boolean): NumberResult {
  const index = Math.ceil(k);
  if (!Number.isFinite(index) || index < 1 || index > numbers.length) return ERR.NUM;
  const list = sorted(numbers);
  return largest ? (list[list.length - index] as number) : (list[index - 1] as number);
}

function interpolate(list: readonly number[], rank: number): number {
  const low = Math.floor(rank);
  const fraction = rank - low;
  const base = list[low] as number;
  if (fraction === 0 || low + 1 >= list.length) return base;
  return base + fraction * ((list[low + 1] as number) - base);
}

/** PERCENTILE.INC: `k` from 0 to 1, linear interpolation over n - 1 steps. */
export function percentileInclusive(numbers: readonly number[], k: number): NumberResult {
  if (numbers.length === 0 || !(k >= 0 && k <= 1)) return ERR.NUM;
  return interpolate(sorted(numbers), k * (numbers.length - 1));
}

/** PERCENTILE.EXC: `k` strictly between 0 and 1, over n + 1 steps. */
export function percentileExclusive(numbers: readonly number[], k: number): NumberResult {
  const n = numbers.length;
  if (n === 0 || !(k > 0 && k < 1)) return ERR.NUM;
  const rank = k * (n + 1);
  if (rank < 1 || rank > n) return ERR.NUM;
  return interpolate(sorted(numbers), rank - 1);
}

/** QUARTILE.INC: quart 0 to 4 (truncated). */
export function quartileInclusive(numbers: readonly number[], quart: number): NumberResult {
  const q = Math.trunc(quart);
  if (!(q >= 0 && q <= 4)) return ERR.NUM;
  return percentileInclusive(numbers, q / 4);
}

/** QUARTILE.EXC: quart 1 to 3 (truncated). */
export function quartileExclusive(numbers: readonly number[], quart: number): NumberResult {
  const q = Math.trunc(quart);
  if (!(q >= 1 && q <= 3)) return ERR.NUM;
  return percentileExclusive(numbers, q / 4);
}

export function product(numbers: readonly number[]): number {
  if (numbers.length === 0) return 0;
  let result = 1;
  for (const n of numbers) result *= n;
  return result;
}

export function maximum(numbers: readonly number[]): number {
  let best = -Infinity;
  for (const n of numbers) if (n > best) best = n;
  return numbers.length === 0 ? 0 : best;
}

export function minimum(numbers: readonly number[]): number {
  let best = Infinity;
  for (const n of numbers) if (n < best) best = n;
  return numbers.length === 0 ? 0 : best;
}
