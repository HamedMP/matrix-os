/**
 * Value coercion for the formula engine and for function libraries.
 *
 * Every function here is pure and never throws for a calculation problem:
 * a value that cannot be converted gives a {@link FormulaError}.
 *
 * The rules, in one place:
 *
 * | From      | to number            | to text               | to boolean          |
 * | --------- | -------------------- | --------------------- | ------------------- |
 * | blank     | `0`                  | `""`                  | `FALSE`             |
 * | number    | itself               | general format        | `FALSE` only for 0  |
 * | boolean   | `1` or `0`           | `TRUE` or `FALSE`     | itself              |
 * | text      | parsed, or `#VALUE!` | itself                | `TRUE`/`FALSE` in any case, or `#VALUE!` |
 * | error     | the error            | the error             | the error           |
 * | array     | its top-left value, then as above                                  |
 *
 * Text that converts to a number: `12`, `-1.5`, `.5`, `1e3`, `50%`,
 * `1,234.5`, `$5`, an ISO date `2024-01-15` with an optional time
 * (`2024-01-15 12:00`, `2024-01-15T12:00:30`) and a time `18:00`.
 *
 * Comparison ({@link compareValues}): numbers sort before text, text before
 * booleans; text compares without regard to case; a blank compares as `0`,
 * `""` or `FALSE` depending on the other side; a number is never equal to
 * text (`1 = "1"` is `FALSE`).
 *
 * Aggregates ({@link collectNumbers}): a value typed directly as an argument
 * is converted (`SUM("2", TRUE)` is 3), while text, booleans and blanks
 * inside a range or array are skipped.
 *
 * Arrays ({@link broadcast}, {@link mapValue}): a scalar function applied
 * element by element, with single rows, columns and cells repeated.
 */

import type {
  FormulaArray,
  FormulaError,
  FormulaErrorCode,
  FormulaScalar,
  FormulaValue,
  RangeBounds,
} from "../../api/formula.js";

/** Builds an error value. `message` is for logs and tooltips only. */
export function makeError(code: FormulaErrorCode, message?: string): FormulaError {
  return message === undefined ? { kind: "error", code } : { kind: "error", code, message };
}

/** Shared error values without a message. Frozen: never mutate them. */
export const ERR = Object.freeze({
  DIV0: Object.freeze(makeError("#DIV/0!")),
  VALUE: Object.freeze(makeError("#VALUE!")),
  REF: Object.freeze(makeError("#REF!")),
  NAME: Object.freeze(makeError("#NAME?")),
  NA: Object.freeze(makeError("#N/A")),
  NUM: Object.freeze(makeError("#NUM!")),
  NULL: Object.freeze(makeError("#NULL!")),
}) as {
  readonly DIV0: FormulaError;
  readonly VALUE: FormulaError;
  readonly REF: FormulaError;
  readonly NAME: FormulaError;
  readonly NA: FormulaError;
  readonly NUM: FormulaError;
  readonly NULL: FormulaError;
};

/** Every error code, for parsing error literals. */
export const ERROR_CODES: readonly FormulaErrorCode[] = [
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#N/A",
  "#NUM!",
  "#NULL!",
];

export function isError(value: unknown): value is FormulaError {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "error";
}

export function isArray(value: FormulaValue): value is FormulaArray {
  return typeof value === "object" && value !== null && value.kind === "array";
}

/**
 * Builds an array value from rows of scalars. Throws for ragged rows, which
 * is a programming error and not a calculation problem.
 */
export function makeArray(values: FormulaScalar[][], ref: RangeBounds | null = null): FormulaArray {
  const cols = values.length === 0 ? 0 : (values[0] as FormulaScalar[]).length;
  for (const row of values) {
    if (row.length !== cols) throw new RangeError("makeArray: every row must have the same length");
  }
  return { kind: "array", rows: values.length, cols, values, ref };
}

/** A scalar as a 1 by 1 computed array; an array is returned as it is. */
export function asArray(value: FormulaValue): FormulaArray {
  if (isArray(value)) return value;
  return { kind: "array", rows: 1, cols: 1, values: [[value]], ref: null };
}

/** The top-left value of an array (blank for an empty one); a scalar is returned as it is. */
export function toScalar(value: FormulaValue): FormulaScalar {
  if (!isArray(value)) return value;
  const row = value.values[0];
  if (row === undefined || row.length === 0) return null;
  return row[0] as FormulaScalar;
}

/** Every scalar of a value, row by row. A scalar gives a list of one. */
export function flattenValues(value: FormulaValue): FormulaScalar[] {
  if (!isArray(value)) return [value];
  const out: FormulaScalar[] = [];
  for (const row of value.values) {
    for (const cell of row) out.push(cell);
  }
  return out;
}

/** The first error among the values, looking inside arrays row by row, or null. */
export function firstError(values: readonly FormulaValue[]): FormulaError | null {
  for (const value of values) {
    if (isError(value)) return value;
    if (isArray(value)) {
      for (const row of value.values) {
        for (const cell of row) {
          if (isError(cell)) return cell;
        }
      }
    }
  }
  return null;
}

const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);
/** Serial numbers below this one are one lower than the day count: 1900 has no 29 February. */
const FIRST_SERIAL_AFTER_FAKE_LEAP_DAY = 61;

/**
 * The serial number of a calendar date. In the 1900 system 1 January 1900
 * is 1 and the serial 60 is the 29 February 1900 that never existed; in the
 * 1904 system 1 January 1904 is 0. The date is not validated.
 */
export function dateSerial(year: number, month: number, day: number, date1904 = false): number {
  const utc = Date.UTC(year, month - 1, day);
  if (date1904) return Math.round((utc - EPOCH_1904) / MS_PER_DAY);
  const serial = Math.round((utc - EPOCH_1900) / MS_PER_DAY);
  return serial < FIRST_SERIAL_AFTER_FAKE_LEAP_DAY ? serial - 1 : serial;
}

const NUMBER_TEXT = /^([+-]?)\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?(%?)$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/;
const TIME_TEXT = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/;

function dayFraction(hours: string, minutes: string, seconds: string | undefined): number | null {
  const h = Number(hours);
  const m = Number(minutes);
  const s = seconds === undefined ? 0 : Number(seconds);
  if (h > 23 || m > 59 || s >= 60) return null;
  return (h * 3600 + m * 60 + s) / 86_400;
}

/**
 * Converts text to a number the way an operator does, or returns null when
 * the text is not a number, date or time. Leading and trailing spaces are
 * ignored. See the module comment for the accepted forms.
 */
export function parseNumberText(text: string, options: { date1904?: boolean } = {}): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 64) return null;
  const numeric = NUMBER_TEXT.exec(trimmed);
  if (numeric !== null) {
    const [, sign, digits, exponent, percent] = numeric;
    const body = (digits as string).replace(/,/g, "");
    let value = Number(exponent === undefined ? body : `${body}e${exponent}`);
    if (!Number.isFinite(value)) return null;
    if (sign === "-") value = -value;
    return percent === "%" ? value / 100 : value;
  }
  const date = DATE_TEXT.exec(trimmed);
  if (date !== null) {
    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    if (year < (options.date1904 === true ? 1904 : 1900)) return null;
    const serial = dateSerial(year, month, day, options.date1904 === true);
    if (date[4] === undefined) return serial;
    const fraction = dayFraction(date[4], date[5] as string, date[6]);
    return fraction === null ? null : serial + fraction;
  }
  const time = TIME_TEXT.exec(trimmed);
  if (time !== null) return dayFraction(time[1] as string, time[2] as string, time[3]);
  return null;
}

/**
 * Converts a value to a number: blank is 0, a boolean is 1 or 0, text is
 * parsed (`#VALUE!` when it is not a number), an error stays an error and an
 * array gives its top-left value.
 */
export function toNumber(value: FormulaValue, options: { date1904?: boolean } = {}): number | FormulaError {
  const scalar = toScalar(value);
  if (typeof scalar === "number") return scalar;
  if (scalar === null) return 0;
  if (typeof scalar === "boolean") return scalar ? 1 : 0;
  if (typeof scalar === "string") {
    const parsed = parseNumberText(scalar, options);
    return parsed === null ? ERR.VALUE : parsed;
  }
  return scalar;
}

/**
 * A number in the general format, without a locale: up to 15 significant
 * digits, and `1.5E+21` or `1.5E-07` where plain digits would be too long.
 */
export function numberToText(value: number): string {
  if (value === 0) return "0";
  if (!Number.isFinite(value)) return "#NUM!";
  const text = String(Number(value.toPrecision(15)));
  const at = text.indexOf("e");
  if (at === -1) return text;
  const mantissa = text.slice(0, at);
  const exponent = Number(text.slice(at + 1));
  const digits = String(Math.abs(exponent)).padStart(2, "0");
  return `${mantissa}E${exponent < 0 ? "-" : "+"}${digits}`;
}

/**
 * Converts a value to text: blank is `""`, a number is written in the
 * general format, a boolean is `TRUE` or `FALSE`, an error stays an error
 * and an array gives its top-left value.
 */
export function toText(value: FormulaValue): string | FormulaError {
  const scalar = toScalar(value);
  if (typeof scalar === "string") return scalar;
  if (scalar === null) return "";
  if (typeof scalar === "number") return numberToText(scalar);
  if (typeof scalar === "boolean") return scalar ? "TRUE" : "FALSE";
  return scalar;
}

/**
 * Converts a value to a boolean: blank is false, a number is true unless it
 * is 0, the text `TRUE` or `FALSE` in any case converts and other text is
 * `#VALUE!`, an error stays an error and an array gives its top-left value.
 */
export function toBoolean(value: FormulaValue): boolean | FormulaError {
  const scalar = toScalar(value);
  if (typeof scalar === "boolean") return scalar;
  if (scalar === null) return false;
  if (typeof scalar === "number") return scalar !== 0;
  if (typeof scalar === "string") {
    const upper = scalar.toUpperCase();
    if (upper === "TRUE") return true;
    if (upper === "FALSE") return false;
    return ERR.VALUE;
  }
  return scalar;
}

/** Relative difference below which two numbers compare as equal (the fifteenth digit). */
const NUMBER_TOLERANCE = 1e-15;

function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (Math.abs(a - b) <= scale * NUMBER_TOLERANCE) return 0;
  return a < b ? -1 : 1;
}

function compareText(a: string, b: string): number {
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 0 for a number, 1 for text, 2 for a boolean, 3 for an error. A blank has no rank of its own. */
function typeRank(value: Exclude<FormulaScalar, null>): number {
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "boolean") return 2;
  return 3;
}

function blankFor(other: Exclude<FormulaScalar, null>): FormulaScalar {
  if (typeof other === "number") return 0;
  if (typeof other === "string") return "";
  if (typeof other === "boolean") return false;
  return null;
}

/**
 * Orders two scalars the way the comparison operators and sorting do:
 * negative when `a` comes first, 0 when they are equal, positive otherwise.
 * Handle errors before calling: an error sorts after everything else here.
 */
export function compareValues(a: FormulaScalar, b: FormulaScalar): number {
  if (a === null && b === null) return 0;
  const left = a === null ? blankFor(b as Exclude<FormulaScalar, null>) : a;
  const right = b === null ? blankFor(a as Exclude<FormulaScalar, null>) : b;
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  const rankLeft = typeRank(left);
  const rankRight = typeRank(right);
  if (rankLeft !== rankRight) return rankLeft < rankRight ? -1 : 1;
  if (typeof left === "number") return compareNumbers(left, right as number);
  if (typeof left === "string") return compareText(left, right as string);
  if (typeof left === "boolean") return left === right ? 0 : left ? 1 : -1;
  return 0;
}

/** True when {@link compareValues} gives 0. */
export function valuesEqual(a: FormulaScalar, b: FormulaScalar): boolean {
  return compareValues(a, b) === 0;
}

export interface CollectNumbersOptions {
  /**
   * Text and booleans typed directly as an argument.
   * `coerce` (default): `"2"` and `TRUE` count, other text is `#VALUE!`.
   * `skip`: text and booleans are left out.
   */
  direct?: "coerce" | "skip";
  /**
   * Text, booleans and blanks inside a range or array.
   * `skip` (default): left out. `zero`: text counts as 0, a boolean as 1 or
   * 0, and a blank is still left out.
   */
  inRange?: "skip" | "zero";
  /** `propagate` (default): the first error is the result. `skip`: errors are left out. */
  errors?: "propagate" | "skip";
}

/**
 * The numbers of a list of arguments, for aggregates such as SUM and
 * AVERAGE. Arrays are read row by row. Returns the first error it meets
 * unless `errors` is `skip`.
 */
export function collectNumbers(
  args: readonly FormulaValue[],
  options: CollectNumbersOptions = {},
): number[] | FormulaError {
  const direct = options.direct ?? "coerce";
  const inRange = options.inRange ?? "skip";
  const skipErrors = options.errors === "skip";
  const out: number[] = [];
  for (const arg of args) {
    if (isArray(arg)) {
      for (const row of arg.values) {
        for (const cell of row) {
          if (typeof cell === "number") out.push(cell);
          else if (cell === null) continue;
          else if (isError(cell)) {
            if (!skipErrors) return cell;
          } else if (inRange === "zero") out.push(cell === true ? 1 : 0);
        }
      }
      continue;
    }
    if (typeof arg === "number") {
      out.push(arg);
      continue;
    }
    if (isError(arg)) {
      if (!skipErrors) return arg;
      continue;
    }
    if (arg === null) {
      out.push(0);
      continue;
    }
    if (direct === "skip") continue;
    const converted = toNumber(arg);
    if (isError(converted)) return converted;
    out.push(converted);
  }
  return out;
}

/** The most cells {@link broadcast} builds unless the caller gives another bound. */
export const MAX_BROADCAST_CELLS = 1_000_000;

/** Number of cells of a value: 1 for a scalar. */
export function cellCount(value: FormulaValue): number {
  return isArray(value) ? value.rows * value.cols : 1;
}

/**
 * The size of the result when the values are combined element by element,
 * or null when every value is a scalar or has at most one cell (the result
 * is then a scalar).
 */
export function broadcastShape(values: readonly FormulaValue[]): { rows: number; cols: number } | null {
  let rows = 1;
  let cols = 1;
  let any = false;
  for (const value of values) {
    if (!isArray(value) || value.rows * value.cols <= 1) continue;
    any = true;
    if (value.rows > rows) rows = value.rows;
    if (value.cols > cols) cols = value.cols;
  }
  return any ? { rows, cols } : null;
}

function elementAt(value: FormulaValue, row: number, col: number): FormulaScalar {
  if (!isArray(value)) return value;
  if (value.rows === 0 || value.cols === 0) return null;
  const r = value.rows === 1 ? 0 : row;
  const c = value.cols === 1 ? 0 : col;
  if (r >= value.rows || c >= value.cols) return ERR.NA;
  return (value.values[r] as FormulaScalar[])[c] as FormulaScalar;
}

/**
 * Applies a scalar function element by element, the way an operator works
 * on arrays (`A1:A3*2`, `{1,2}+{10;20}`).
 *
 * When every value is a scalar or a single cell the result is a scalar.
 * Otherwise the result is a computed array as tall and as wide as the
 * largest value: a single row is repeated down, a single column is repeated
 * across, a single cell everywhere, and a position outside a smaller array
 * reads `#N/A`. An array without cells reads as one blank.
 *
 * `fn` receives one scalar per value. The list it receives is reused
 * between calls: read it, do not keep it. Errors are not filtered out, so
 * `fn` decides how they propagate. A result larger than `maxCells` is `#NUM!`.
 */
export function broadcast(
  values: readonly FormulaValue[],
  fn: (scalars: readonly FormulaScalar[]) => FormulaScalar,
  maxCells: number = MAX_BROADCAST_CELLS,
): FormulaValue {
  const shape = broadcastShape(values);
  const scratch: FormulaScalar[] = new Array<FormulaScalar>(values.length).fill(null);
  if (shape === null) {
    for (let i = 0; i < values.length; i += 1) scratch[i] = elementAt(values[i] as FormulaValue, 0, 0);
    return fn(scratch);
  }
  if (shape.rows * shape.cols > maxCells) return makeError("#NUM!", "array result is too large");
  const out: FormulaScalar[][] = [];
  for (let row = 0; row < shape.rows; row += 1) {
    const line: FormulaScalar[] = new Array<FormulaScalar>(shape.cols);
    for (let col = 0; col < shape.cols; col += 1) {
      for (let i = 0; i < values.length; i += 1) scratch[i] = elementAt(values[i] as FormulaValue, row, col);
      line[col] = fn(scratch);
    }
    out.push(line);
  }
  return { kind: "array", rows: shape.rows, cols: shape.cols, values: out, ref: null };
}

/** {@link broadcast} for one value: a scalar gives a scalar, an array gives a computed array of the same size. */
export function mapValue(value: FormulaValue, fn: (scalar: FormulaScalar) => FormulaScalar): FormulaValue {
  return broadcast([value], (scalars) => fn(scalars[0] as FormulaScalar));
}

/** A number result checked for overflow: `NaN` and infinities become `#NUM!`. */
export function finiteOrError(value: number): number | FormulaError {
  return Number.isFinite(value) ? value : ERR.NUM;
}
