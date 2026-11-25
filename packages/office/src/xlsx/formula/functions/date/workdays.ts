/**
 * Working days: NETWORKDAYS and WORKDAY. Saturday and Sunday are the
 * weekend; holidays are an optional range or array of dates. Both run in
 * time proportional to the number of holidays, not the length of the span.
 */

import type { FormulaArg, FormulaError, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, flattenValues, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { intArg } from "../text/args.js";
import { dateResult, dayArg, weekdayOf } from "./serial.js";

type Context = FunctionContext;

function isWeekday(day: number, context: Context): boolean {
  const wd = weekdayOf(day, context);
  return wd !== 0 && wd !== 6;
}

/** Distinct holidays that fall on a weekday, sorted ascending. */
function holidayList(value: FormulaValue | undefined, context: Context): number[] | FormulaError {
  if (value === undefined || value === null) return [];
  const days = new Set<number>(); // Bounded by the cells of the holiday argument.
  for (const cell of flattenValues(value)) {
    if (cell === null) continue;
    if (isError(cell)) return cell;
    if (typeof cell === "boolean") return ERR.VALUE;
    const day = dayArg(cell, context);
    if (isError(day)) return day;
    if (isWeekday(day, context)) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** Number of sorted values `v` with `lo <= v < hi`. */
function countBetween(sorted: readonly number[], lo: number, hi: number): number {
  const lower = (x: number): number => {
    let a = 0;
    let b = sorted.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if ((sorted[m] as number) < x) a = m + 1;
      else b = m;
    }
    return a;
  };
  return hi <= lo ? 0 : lower(hi) - lower(lo);
}

/** Weekdays from `a` to `b` inclusive, `a <= b`. */
function weekdaysBetween(a: number, b: number, context: Context): number {
  const total = b - a + 1;
  const weeks = Math.floor(total / 7);
  let count = weeks * 5;
  for (let day = a + weeks * 7; day <= b; day += 1) if (isWeekday(day, context)) count += 1;
  return count;
}

function networkdays(args: readonly FormulaArg[], context: Context): FormulaValue {
  const start = dayArg(args[0], context);
  if (isError(start)) return start;
  const end = dayArg(args[1], context);
  if (isError(end)) return end;
  const holidays = holidayList(args[2], context);
  if (isError(holidays)) return holidays;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const count = weekdaysBetween(lo, hi, context) - countBetween(holidays, lo, hi + 1);
  return start <= end ? count : -count;
}

/** The weekday `n` weekdays after (n > 0) or before (n < 0) `from`, ignoring holidays. */
function advance(from: number, n: number, context: Context): number {
  const forward = n > 0;
  const steps = Math.abs(n);
  let day = from;
  const wd = weekdayOf(day, context);
  if (forward && wd === 6) day -= 1;
  else if (forward && wd === 0) day -= 2;
  else if (!forward && wd === 6) day += 2;
  else if (!forward && wd === 0) day += 1;
  const weeks = Math.floor((steps - 1) / 5);
  day += (forward ? 7 : -7) * weeks;
  let remaining = steps - weeks * 5;
  while (remaining > 0) {
    day += forward ? 1 : -1;
    if (isWeekday(day, context)) remaining -= 1;
  }
  return day;
}

function workday(args: readonly FormulaArg[], context: Context): FormulaValue {
  const start = dayArg(args[0], context);
  if (isError(start)) return start;
  const n = intArg(args[1]);
  if (isError(n)) return n;
  const holidays = holidayList(args[2], context);
  if (isError(holidays)) return holidays;
  if (n === 0) return start;
  if (Math.abs(n) > 3_000_000) return ERR.NUM;
  const forward = n > 0;
  let target = advance(start, n, context);
  for (let i = 0; i <= holidays.length; i += 1) {
    const skipped = forward ? countBetween(holidays, start + 1, target + 1) : countBetween(holidays, target, start);
    const next = advance(start, forward ? n + skipped : n - skipped, context);
    if (next === target) break;
    target = next;
  }
  return dateResult(target, context);
}

/** Registers NETWORKDAYS and WORKDAY. */
export function registerWorkdayFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "NETWORKDAYS", networkdays, { minArgs: 2, maxArgs: 3, ranges: [2] });
  registerFunction(registry, "WORKDAY", workday, { minArgs: 2, maxArgs: 3, ranges: [2] });
}
