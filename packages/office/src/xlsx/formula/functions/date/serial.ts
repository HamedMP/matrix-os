/**
 * Serial-number helpers for the date functions. A date is a serial number
 * (1900 system by default, with the 29 February 1900 that never existed as
 * serial 60; 1904 system when the workbook says so). The fraction is the
 * time of day.
 */

import type { FormulaError, FormulaValue, FunctionContext } from "../../../../api/formula.js";
import { MAX_SERIAL, type DateParts, partsToSerial, serialToParts } from "../../../format/index.js";
import { ERR, isError, toNumber, toScalar } from "../../coerce.js";
import { parseDateText } from "./parse.js";

export type { DateParts };

/** Days between 1900-01-01 and 1904-01-01 in serial numbers. */
const SYSTEM_OFFSET = 1462;

type DateContext = Pick<FunctionContext, "date1904" | "now">;

/** The largest serial of the context's date system (31 December 9999). */
export function maxSerial(context: DateContext): number {
  return context.date1904 ? MAX_SERIAL - SYSTEM_OFFSET : MAX_SERIAL;
}

/**
 * A date argument as a serial number: numbers as they are, text parsed as
 * a number or a date. Negative serials and serials after 9999 are `#NUM!`.
 */
export function serialArg(value: FormulaValue | undefined, context: DateContext): number | FormulaError {
  const scalar = toScalar(value ?? null);
  let n = toNumber(scalar, { date1904: context.date1904 });
  if (isError(n) && typeof scalar === "string") {
    const parsed = parseDateText(scalar, context);
    if (parsed !== null) n = parsed;
  }
  if (isError(n)) return n;
  if (n < 0 || n >= maxSerial(context) + 1) return ERR.NUM;
  return n;
}

/** A date argument without its time of day. */
export function dayArg(value: FormulaValue | undefined, context: DateContext): number | FormulaError {
  const serial = serialArg(value, context);
  return isError(serial) ? serial : Math.floor(serial);
}

/** Calendar parts of a serial already checked by {@link serialArg}. */
export function partsOf(serial: number, context: DateContext): DateParts {
  return serialToParts(serial, context.date1904) as DateParts;
}

/** A date result: `#NUM!` when it falls outside the date system. */
export function dateResult(serial: number, context: DateContext): number | FormulaError {
  if (!Number.isFinite(serial) || serial < 0 || serial >= maxSerial(context) + 1) return ERR.NUM;
  return serial;
}

/** The serial of a calendar date; month and day may overflow either way. */
export function serialOf(year: number, month: number, day: number, context: DateContext): number {
  return partsToSerial(year, month, day, 0, 0, 0, context.date1904);
}

/** Number of days in a month of the real calendar. */
export function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/** True for a leap year of the real calendar. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Weekday of a day serial: 0 is Sunday. Matches the spreadsheet's calendar, including before March 1900. */
export function weekdayOf(day: number, context: DateContext): number {
  return context.date1904 ? (day + 5) % 7 : (day + 6) % 7;
}
