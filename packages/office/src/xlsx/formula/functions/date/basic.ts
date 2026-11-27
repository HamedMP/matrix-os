/**
 * Date and time construction and parts: DATE, TIME, TODAY, NOW, YEAR,
 * MONTH, DAY, HOUR, MINUTE, SECOND, WEEKDAY, WEEKNUM, ISOWEEKNUM, DAYS and
 * DATEVALUE. TODAY and NOW read the evaluation context's `now`, never a clock.
 */

import type { FormulaArg, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { ERR, isError } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { intArg } from "../text/args.js";
import { nowSerial, parseDateText } from "./parse.js";
import { type DateParts, dateResult, dayArg, partsOf, serialArg, serialOf, weekdayOf } from "./serial.js";

function date(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  let year = intArg(args[0]);
  if (isError(year)) return year;
  const month = intArg(args[1]);
  if (isError(month)) return month;
  const day = intArg(args[2]);
  if (isError(day)) return day;
  if (year < 0 || year >= 10_000) return ERR.NUM;
  if (year < 1900) year += 1900;
  return dateResult(serialOf(year, month, day, context), context);
}

function time(args: readonly FormulaArg[]): FormulaValue {
  const parts: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const n = intArg(args[i]);
    if (isError(n)) return n;
    if (n > 32_767) return ERR.NUM;
    parts.push(n);
  }
  const seconds = (parts[0] as number) * 3600 + (parts[1] as number) * 60 + (parts[2] as number);
  if (seconds < 0) return ERR.NUM;
  return (seconds % 86_400) / 86_400;
}

function now(_args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const serial = nowSerial(context);
  return serial === null ? ERR.NA : serial;
}

function today(_args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const serial = nowSerial(context);
  return serial === null ? ERR.NA : Math.floor(serial);
}

function part(pick: (parts: DateParts) => number): (args: readonly FormulaArg[], context: FunctionContext) => FormulaValue {
  return (args, context) => {
    const serial = serialArg(args[0], context);
    return isError(serial) ? serial : pick(partsOf(serial, context));
  };
}

function weekday(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const day = dayArg(args[0], context);
  if (isError(day)) return day;
  const type = intArg(args[1], 1);
  if (isError(type)) return type;
  const wd = weekdayOf(day, context);
  if (type === 1) return wd + 1;
  if (type === 2) return ((wd + 6) % 7) + 1;
  if (type === 3) return (wd + 6) % 7;
  if (type >= 11 && type <= 17) return ((wd - ((type - 10) % 7) + 7) % 7) + 1;
  return ERR.NUM;
}

/** ISO 8601 week number of a day serial. */
function isoWeek(day: number, context: FunctionContext): number {
  const isoWeekday = ((weekdayOf(day, context) + 6) % 7) + 1;
  const thursday = day - isoWeekday + 4;
  const year = partsOf(Math.max(0, thursday), context).year;
  const jan1 = serialOf(year, 1, 1, context);
  return Math.floor((thursday - jan1) / 7) + 1;
}

/** First weekday of the week for each WEEKNUM return type (0 is Sunday). */
const WEEK_START: Readonly<Record<number, number>> = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };

function weeknum(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const day = dayArg(args[0], context);
  if (isError(day)) return day;
  const type = intArg(args[1], 1);
  if (isError(type)) return type;
  if (type === 21) return isoWeek(day, context);
  const start = WEEK_START[type];
  if (start === undefined) return ERR.NUM;
  const year = partsOf(day, context).year;
  const jan1 = Math.max(0, serialOf(year, 1, 1, context));
  const offset = (weekdayOf(jan1, context) - start + 7) % 7;
  return Math.floor((day - jan1 + offset) / 7) + 1;
}

function isoWeekNum(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const day = dayArg(args[0], context);
  return isError(day) ? day : isoWeek(day, context);
}

function days(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const end = dayArg(args[0], context);
  if (isError(end)) return end;
  const start = dayArg(args[1], context);
  if (isError(start)) return start;
  return end - start;
}

function dateValue(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const text = args[0] ?? null;
  if (isError(text)) return text;
  if (typeof text !== "string") return ERR.VALUE;
  const serial = parseDateText(text, context);
  return serial === null ? ERR.VALUE : Math.floor(serial);
}

/** Registers the date construction and date part functions. */
export function registerBasicDateFunctions(registry: FunctionRegistry): void {
  const scalar = { ranges: "none" as const };
  registerFunction(registry, "DATE", date, { minArgs: 3, maxArgs: 3, ...scalar });
  registerFunction(registry, "TIME", time, { minArgs: 3, maxArgs: 3, ...scalar });
  registerFunction(registry, "NOW", now, { minArgs: 0, maxArgs: 0, volatile: true, ...scalar });
  registerFunction(registry, "TODAY", today, { minArgs: 0, maxArgs: 0, volatile: true, ...scalar });
  registerFunction(registry, "YEAR", part((p) => p.year), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "MONTH", part((p) => p.month), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "DAY", part((p) => p.day), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "HOUR", part((p) => p.hour), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "MINUTE", part((p) => p.minute), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "SECOND", part((p) => p.second), { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "WEEKDAY", weekday, { minArgs: 1, maxArgs: 2, ...scalar });
  registerFunction(registry, "WEEKNUM", weeknum, { minArgs: 1, maxArgs: 2, ...scalar });
  registerFunction(registry, "ISOWEEKNUM", isoWeekNum, { minArgs: 1, maxArgs: 1, ...scalar });
  registerFunction(registry, "DAYS", days, { minArgs: 2, maxArgs: 2, ...scalar });
  registerFunction(registry, "DATEVALUE", dateValue, { minArgs: 1, maxArgs: 1, ...scalar });
}
