/**
 * Calendar arithmetic: EDATE, EOMONTH, DATEDIF and YEARFRAC.
 */

import type { FormulaArg, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { intArg, textArg } from "../text/args.js";
import { type DateParts, dateResult, dayArg, daysInMonth, isLeapYear, partsOf, serialOf } from "./serial.js";

/** Year and month `months` after the month of `parts`. */
function shiftMonth(parts: DateParts, months: number): { year: number; month: number } {
  const total = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(total / 12);
  return { year, month: total - year * 12 + 1 };
}

function edate(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const start = dayArg(args[0], context);
  if (isError(start)) return start;
  const months = intArg(args[1]);
  if (isError(months)) return months;
  const parts = partsOf(start, context);
  const target = shiftMonth(parts, months);
  if (target.year < 1900 || target.year > 9999) return ERR.NUM;
  const day = Math.min(parts.day, daysInMonth(target.year, target.month));
  return dateResult(serialOf(target.year, target.month, day, context), context);
}

function eomonth(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const start = dayArg(args[0], context);
  if (isError(start)) return start;
  const months = intArg(args[1]);
  if (isError(months)) return months;
  const target = shiftMonth(partsOf(start, context), months);
  if (target.year < 1900 || target.year > 9999) return ERR.NUM;
  return dateResult(serialOf(target.year, target.month + 1, 0, context), context);
}

function datedif(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const start = dayArg(args[0], context);
  if (isError(start)) return start;
  const end = dayArg(args[1], context);
  if (isError(end)) return end;
  const unit = textArg(args[2]);
  if (isError(unit)) return unit;
  if (start > end) return ERR.NUM;
  const s = partsOf(start, context);
  const e = partsOf(end, context);
  const months = (e.year - s.year) * 12 + e.month - s.month - (e.day < s.day ? 1 : 0);
  switch (unit.toUpperCase()) {
    case "D":
      return end - start;
    case "M":
      return months;
    case "Y":
      return Math.floor(months / 12);
    case "YM":
      return months % 12;
    case "MD": {
      if (e.day >= s.day) return e.day - s.day;
      const previous = e.month === 1 ? { year: e.year - 1, month: 12 } : { year: e.year, month: e.month - 1 };
      return daysInMonth(previous.year, previous.month) - s.day + e.day;
    }
    case "YD": {
      let anniversary = serialOf(e.year, s.month, s.day, context);
      if (anniversary > end) anniversary = serialOf(e.year - 1, s.month, s.day, context);
      return end - anniversary;
    }
    default:
      return ERR.NUM;
  }
}

function isLastDayOfFebruary(parts: DateParts): boolean {
  return parts.month === 2 && parts.day === daysInMonth(parts.year, 2);
}

/** US (NASD) 30/360, as YEARFRAC basis 0 applies it. */
function us30360(s: DateParts, e: DateParts): number {
  let d1 = s.day;
  let d2 = e.day;
  if (d1 === 31 && d2 === 31) {
    d1 = 30;
    d2 = 30;
  } else if (d1 === 31) {
    d1 = 30;
  } else if (d1 === 30 && d2 === 31) {
    d2 = 30;
  } else if (isLastDayOfFebruary(s) && isLastDayOfFebruary(e)) {
    d1 = 30;
    d2 = 30;
  } else if (isLastDayOfFebruary(s)) {
    d1 = 30;
  }
  return ((e.year - s.year) * 360 + (e.month - s.month) * 30 + (d2 - d1)) / 360;
}

/** European 30/360 (basis 4). */
function european30360(s: DateParts, e: DateParts): number {
  const d1 = Math.min(s.day, 30);
  const d2 = Math.min(e.day, 30);
  return ((e.year - s.year) * 360 + (e.month - s.month) * 30 + (d2 - d1)) / 360;
}

/** True when the span from `start` to `end` passes 1 March of a leap year at either end. */
function crossesLeapDay(start: number, end: number, s: DateParts, e: DateParts, context: FunctionContext): boolean {
  if (isLeapYear(s.year)) {
    const march = serialOf(s.year, 3, 1, context);
    if (start < march && end >= march) return true;
  }
  if (isLeapYear(e.year)) {
    const march = serialOf(e.year, 3, 1, context);
    if (end >= march && start < march) return true;
  }
  return false;
}

/** Actual/actual (basis 1). */
function actualActual(start: number, end: number, s: DateParts, e: DateParts, context: FunctionContext): number {
  const span = end - start;
  const withinYear =
    s.year === e.year || (s.year + 1 === e.year && (s.month > e.month || (s.month === e.month && s.day >= e.day)));
  if (withinYear) {
    const leap =
      (s.year === e.year && isLeapYear(s.year)) ||
      crossesLeapDay(start, end, s, e, context) ||
      (e.month === 2 && e.day === 29);
    return span / (leap ? 366 : 365);
  }
  const years = e.year - s.year + 1;
  const daysInYears = serialOf(e.year + 1, 1, 1, context) - serialOf(s.year, 1, 1, context);
  return span / (daysInYears / years);
}

function yearfrac(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  let start = dayArg(args[0], context);
  if (isError(start)) return start;
  let end = dayArg(args[1], context);
  if (isError(end)) return end;
  const basis = intArg(args[2], 0);
  if (isError(basis)) return basis;
  if (basis < 0 || basis > 4) return ERR.NUM;
  if (start > end) [start, end] = [end, start];
  const s = partsOf(start, context);
  const e = partsOf(end, context);
  switch (basis) {
    case 0:
      return us30360(s, e);
    case 1:
      return actualActual(start, end, s, e, context);
    case 2:
      return (end - start) / 360;
    case 3:
      return (end - start) / 365;
    default:
      return european30360(s, e);
  }
}

/** Registers EDATE, EOMONTH, DATEDIF and YEARFRAC. */
export function registerCalendarFunctions(registry: FunctionRegistry): void {
  const scalar = { ranges: "none" as const };
  registerFunction(registry, "EDATE", edate, { minArgs: 2, maxArgs: 2, ...scalar });
  registerFunction(registry, "EOMONTH", eomonth, { minArgs: 2, maxArgs: 2, ...scalar });
  registerFunction(registry, "DATEDIF", datedif, { minArgs: 3, maxArgs: 3, ...scalar });
  registerFunction(registry, "YEARFRAC", yearfrac, { minArgs: 2, maxArgs: 3, ...scalar });
}
