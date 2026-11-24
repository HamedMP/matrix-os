/**
 * Argument hints for functions.
 *
 * The names and the number of arguments come from the engine's function
 * registry, so every function the engine calculates is offered. The registry
 * has no argument names; the table below gives them for the common
 * functions, and the others get generic names from their argument counts.
 */

import { createFunctionRegistry } from "../session/engine";

export interface FunctionHint {
  name: string;
  /** Argument names in order. One in square brackets is optional; `…` repeats the one before. */
  args: string[];
  /** One line on what the function gives. Empty when unknown. */
  summary: string;
}

const SIGNATURES: Record<string, readonly [string, string]> = {
  SUM: ["number1, [number2], …", "Adds numbers."],
  AVERAGE: ["number1, [number2], …", "The mean of numbers."],
  MIN: ["number1, [number2], …", "The smallest number."],
  MAX: ["number1, [number2], …", "The largest number."],
  COUNT: ["value1, [value2], …", "Counts cells that hold numbers."],
  COUNTA: ["value1, [value2], …", "Counts cells that are not empty."],
  COUNTBLANK: ["range", "Counts empty cells."],
  PRODUCT: ["number1, [number2], …", "Multiplies numbers."],
  SUMPRODUCT: ["array1, [array2], …", "Adds the products of matching entries."],
  MEDIAN: ["number1, [number2], …", "The middle number."],
  SUMIF: ["range, criteria, [sum_range]", "Adds the cells that meet a condition."],
  SUMIFS: ["sum_range, criteria_range1, criteria1, …", "Adds the cells that meet every condition."],
  COUNTIF: ["range, criteria", "Counts the cells that meet a condition."],
  COUNTIFS: ["criteria_range1, criteria1, …", "Counts the cells that meet every condition."],
  AVERAGEIF: ["range, criteria, [average_range]", "The mean of the cells that meet a condition."],
  AVERAGEIFS: ["average_range, criteria_range1, criteria1, …", "The mean of the cells that meet every condition."],
  IF: ["condition, value_if_true, [value_if_false]", "One value when the condition holds, another when not."],
  IFS: ["condition1, value1, [condition2, value2], …", "The value of the first condition that holds."],
  IFERROR: ["value, value_if_error", "The value, or a fallback when it is an error."],
  IFNA: ["value, value_if_na", "The value, or a fallback when it is #N/A."],
  AND: ["logical1, [logical2], …", "True when all are true."],
  OR: ["logical1, [logical2], …", "True when any is true."],
  NOT: ["logical", "Reverses true and false."],
  XOR: ["logical1, [logical2], …", "True when an odd number are true."],
  SWITCH: ["expression, value1, result1, …, [default]", "The result paired with the matching value."],
  CHOOSE: ["index, value1, [value2], …", "The value at a position."],
  ABS: ["number", "The number without its sign."],
  ROUND: ["number, digits", "Rounds to a number of digits."],
  ROUNDUP: ["number, digits", "Rounds away from zero."],
  ROUNDDOWN: ["number, digits", "Rounds towards zero."],
  INT: ["number", "Rounds down to a whole number."],
  TRUNC: ["number, [digits]", "Cuts off digits."],
  MOD: ["number, divisor", "The remainder of a division."],
  POWER: ["number, power", "A number raised to a power."],
  SQRT: ["number", "The square root."],
  EXP: ["number", "e raised to a power."],
  LN: ["number", "The natural logarithm."],
  LOG: ["number, [base]", "The logarithm to a base."],
  LOG10: ["number", "The logarithm to base 10."],
  SIGN: ["number", "1, 0 or -1 for the sign."],
  CEILING: ["number, significance", "Rounds up to a multiple."],
  FLOOR: ["number, significance", "Rounds down to a multiple."],
  PI: ["", "The number pi."],
  RAND: ["", "A random number from 0 up to 1."],
  VLOOKUP: ["lookup_value, table, column_index, [approximate]", "Finds a value in the first column and returns one from the same row."],
  HLOOKUP: ["lookup_value, table, row_index, [approximate]", "Finds a value in the first row and returns one from the same column."],
  XLOOKUP: ["lookup_value, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]", "Finds a value in one range and returns the matching one from another."],
  INDEX: ["range, row, [column]", "The value at a position in a range."],
  MATCH: ["lookup_value, range, [match_type]", "The position of a value in a range."],
  ROW: ["[reference]", "The row number of a reference."],
  COLUMN: ["[reference]", "The column number of a reference."],
  ROWS: ["range", "The number of rows in a range."],
  COLUMNS: ["range", "The number of columns in a range."],
  CONCATENATE: ["text1, [text2], …", "Joins text."],
  CONCAT: ["text1, [text2], …", "Joins text and ranges of text."],
  TEXTJOIN: ["delimiter, ignore_empty, text1, [text2], …", "Joins text with a delimiter."],
  LEFT: ["text, [count]", "The first characters of text."],
  RIGHT: ["text, [count]", "The last characters of text."],
  MID: ["text, start, count", "Characters from the middle of text."],
  LEN: ["text", "The number of characters."],
  TRIM: ["text", "Removes extra spaces."],
  UPPER: ["text", "Text in upper case."],
  LOWER: ["text", "Text in lower case."],
  PROPER: ["text", "Text with each word capitalised."],
  FIND: ["find_text, within_text, [start]", "The position of text in other text, matching case."],
  SEARCH: ["find_text, within_text, [start]", "The position of text in other text, ignoring case."],
  SUBSTITUTE: ["text, old_text, new_text, [instance]", "Replaces text by matching it."],
  REPLACE: ["text, start, count, new_text", "Replaces text by position."],
  REPT: ["text, times", "Repeats text."],
  TEXT: ["value, format", "A value as text in a number format."],
  VALUE: ["text", "Text as a number."],
  EXACT: ["text1, text2", "True when two texts are the same, matching case."],
  DATE: ["year, month, day", "A date from its parts."],
  YEAR: ["date", "The year of a date."],
  MONTH: ["date", "The month of a date."],
  DAY: ["date", "The day of a date."],
  WEEKDAY: ["date, [type]", "The day of the week as a number."],
  TODAY: ["", "Today's date."],
  NOW: ["", "The current date and time."],
  EDATE: ["start_date, months", "The date a number of months away."],
  EOMONTH: ["start_date, months", "The last day of a month a number of months away."],
  DAYS: ["end_date, start_date", "The days between two dates."],
  DATEDIF: ["start_date, end_date, unit", "The time between two dates in a unit."],
  ISBLANK: ["value", "True for an empty cell."],
  ISNUMBER: ["value", "True for a number."],
  ISTEXT: ["value", "True for text."],
  ISLOGICAL: ["value", "True for TRUE or FALSE."],
  ISERROR: ["value", "True for any error."],
  ISERR: ["value", "True for any error except #N/A."],
  ISNA: ["value", "True for #N/A."],
  NA: ["", "The error #N/A."],
  PMT: ["rate, periods, present_value, [future_value], [type]", "The payment of a loan."],
  PV: ["rate, periods, payment, [future_value], [type]", "The present value of an investment."],
  FV: ["rate, periods, payment, [present_value], [type]", "The future value of an investment."],
  NPV: ["rate, value1, [value2], …", "The net present value of cash flows."],
  IRR: ["values, [guess]", "The internal rate of return."],
  FILTER: ["range, include, [if_empty]", "The rows of a range that meet a condition."],
  UNIQUE: ["range, [by_column], [exactly_once]", "The distinct values of a range."],
  SORT: ["range, [sort_index], [sort_order], [by_column]", "A range in sorted order."],
};

const GENERIC_MAX = 4;

function genericArgs(minArgs: number, maxArgs: number | null): string[] {
  const args: string[] = [];
  const shown = maxArgs === null ? Math.max(minArgs, 1) : Math.min(maxArgs, Math.max(minArgs, GENERIC_MAX));
  for (let i = 0; i < shown; i++) args.push(i < minArgs ? `value${i + 1}` : `[value${i + 1}]`);
  if (maxArgs === null || maxArgs > shown) args.push("…");
  return args;
}

function splitArgs(signature: string): string[] {
  return signature === "" ? [] : signature.split(",").map((part) => part.trim());
}

export interface FunctionCatalog {
  /** Every function name, upper case, sorted. */
  names: string[];
  hint(name: string): FunctionHint | null;
}

/** The functions of the engine with their hints. Build it once and keep it. */
export function createFunctionCatalog(): FunctionCatalog {
  const registry = createFunctionRegistry();
  const names = registry.names();
  return {
    names,
    hint(name: string): FunctionHint | null {
      const upper = name.toUpperCase();
      const info = registry.describe(upper);
      if (info === null) return null;
      const known = SIGNATURES[upper];
      if (known !== undefined) return { name: upper, args: splitArgs(known[0]), summary: known[1] };
      return { name: upper, args: genericArgs(info.minArgs, info.maxArgs), summary: "" };
    },
  };
}

/**
 * Which entry of `hint.args` the caret's argument is: the argument itself,
 * or the repeating entry before a `…` once the arguments run past the list.
 * -1 when the function takes no such argument.
 */
export function activeHintArg(hint: FunctionHint, argument: number): number {
  const args = hint.args;
  if (args.length === 0) return -1;
  const dots = args.indexOf("…");
  if (dots < 0) return argument < args.length ? argument : -1;
  if (argument < dots) return argument;
  // `…` in the middle (SWITCH): the entries after it are not positional.
  return Math.max(0, dots - 1);
}
