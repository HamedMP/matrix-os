/**
 * Reading dates typed as text, for DATEVALUE, VALUE and date arguments.
 *
 * Accepted (month names in English, three letters or full, any case):
 * `2024-01-15`, `2024/1/15`, `1/15/2024` (month first), `1/15/24`,
 * `15-Jan-2024`, `15 January 2024`, `Jan 15, 2024`, `January 15 2024`, and
 * without a year (`15-Jan`, `Jan 15`, `1/15`), which takes the year of the
 * evaluation's current time. Any of them may be followed by a time
 * `h:mm`, `h:mm:ss` with an optional `AM` or `PM`. Two-digit years 00 to 29
 * are 2000 to 2029 and 30 to 99 are 1930 to 1999.
 *
 * The current instant is always the caller's `now` string; this file never
 * reads a clock.
 */

import type { FunctionContext } from "../../../../api/formula.js";
import { partsToSerial } from "../../../format/index.js";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const FULL_MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

const TIME_SUFFIX = /^(.+?)(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/;
const YMD = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const MDY = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2}|\d{4}))?$/;
const D_MON_Y = /^(\d{1,2})[-\s]([A-Za-z]{3,9})\.?(?:[-\s,]+(\d{2}|\d{4}))?$/;
const MON_D_Y = /^([A-Za-z]{3,9})\.?[-\s]+(\d{1,2})(?:(?:,\s*|[-\s]+)(\d{2}|\d{4}))?$/;
const NOW_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

function monthNumber(name: string): number | null {
  const upper = name.toUpperCase();
  const short = MONTHS.indexOf(upper);
  if (short !== -1) return short + 1;
  const full = FULL_MONTHS.indexOf(upper);
  return full === -1 ? null : full + 1;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length === 4) return year;
  return year < 30 ? 2000 + year : 1900 + year;
}

/** The year of the evaluation's current time, or null without one. */
function currentYear(now: string | null): number | null {
  if (now === null) return null;
  const match = /^(\d{4})-/.exec(now);
  return match === null ? null : Number(match[1]);
}

/** Serial of a calendar date after checking it is on the calendar; 29 February 1900 is the serial 60. */
export function checkedSerial(year: number, month: number, day: number, date1904: boolean): number | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const leap1900 = !date1904 && year === 1900 && month === 2 && day === 29;
  if (!leap1900 && day > daysInMonth(year, month)) return null;
  if (year < (date1904 ? 1904 : 1900) || year > 9999) return null;
  return partsToSerial(year, month, day, 0, 0, 0, date1904);
}

function datePart(text: string, context: Pick<FunctionContext, "date1904" | "now">): number | null {
  let year: number | null;
  let month: number | null;
  let day: number;
  let match = YMD.exec(text);
  if (match !== null) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if ((match = MDY.exec(text)) !== null) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = match[3] === undefined ? currentYear(context.now) : fullYear(match[3]);
  } else if ((match = D_MON_Y.exec(text)) !== null) {
    day = Number(match[1]);
    month = monthNumber(match[2] as string);
    year = match[3] === undefined ? currentYear(context.now) : fullYear(match[3]);
  } else if ((match = MON_D_Y.exec(text)) !== null) {
    month = monthNumber(match[1] as string);
    day = Number(match[2]);
    year = match[3] === undefined ? currentYear(context.now) : fullYear(match[3]);
  } else {
    return null;
  }
  if (year === null || month === null) return null;
  return checkedSerial(year, month, day, context.date1904);
}

function timePart(hours: string, minutes: string, seconds: string | undefined, meridiem: string | undefined): number | null {
  let h = Number(hours);
  const m = Number(minutes);
  const s = seconds === undefined ? 0 : Number(seconds);
  if (meridiem !== undefined) {
    if (h < 1 || h > 12) return null;
    const pm = meridiem.toUpperCase() === "PM";
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || m > 59 || s >= 60) return null;
  return (h * 3600 + m * 60 + s) / 86_400;
}

/**
 * The serial of a date written as text (with its time of day as the
 * fraction), or null when the text is not a date. See the module comment.
 */
export function parseDateText(text: string, context: Pick<FunctionContext, "date1904" | "now">): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 64) return null;
  const timed = TIME_SUFFIX.exec(trimmed);
  if (timed !== null && timed[1] !== "") {
    const date = datePart(timed[1] as string, context);
    if (date === null) return null;
    const time = timePart(timed[2] as string, timed[3] as string, timed[4], timed[5]);
    return time === null ? null : date + time;
  }
  return datePart(trimmed, context);
}

/**
 * The serial of the evaluation's current instant: the wall-clock date and
 * time written in `now` (an offset or `Z` is accepted and not applied).
 * Null when `now` is missing or not an ISO 8601 time.
 */
export function nowSerial(context: Pick<FunctionContext, "date1904" | "now">): number | null {
  if (context.now === null) return null;
  const match = NOW_TEXT.exec(context.now.trim());
  if (match === null) return null;
  const date = checkedSerial(Number(match[1]), Number(match[2]), Number(match[3]), context.date1904);
  if (date === null) return null;
  if (match[4] === undefined) return date;
  const seconds = Number(match[6] ?? 0) + (match[7] === undefined ? 0 : Number(`0.${match[7]}`));
  const time = timePart(match[4], match[5] as string, String(seconds), undefined);
  return time === null ? null : date + time;
}
