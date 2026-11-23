/**
 * Argument helpers shared by the text, date, lookup and financial libraries.
 * Every helper returns a {@link FormulaError} instead of throwing.
 */

import type { FormulaError, FormulaValue } from "../../../../api/formula.js";
import { ERR, isError, toBoolean, toNumber, toText } from "../../coerce.js";
import { MAX_TEXT_LENGTH } from "../../eval/operators.js";

export { MAX_TEXT_LENGTH };

/** A number argument, or its default when the argument was left out (`null`). */
export function numberArg(value: FormulaValue | undefined, fallback?: number): number | FormulaError {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  return toNumber(value ?? null);
}

/** A number argument truncated toward zero. */
export function intArg(value: FormulaValue | undefined, fallback?: number): number | FormulaError {
  const n = numberArg(value, fallback);
  return isError(n) ? n : Math.trunc(n);
}

/** A boolean argument, or its default when left out. */
export function boolArg(value: FormulaValue | undefined, fallback: boolean): boolean | FormulaError {
  if (value === undefined || value === null) return fallback;
  return toBoolean(value);
}

/** A text argument. */
export function textArg(value: FormulaValue | undefined): string | FormulaError {
  return toText(value ?? null);
}

/** Text checked against the cell text limit. */
export function boundedText(text: string): string | FormulaError {
  return text.length > MAX_TEXT_LENGTH ? ERR.VALUE : text;
}

/** True when the argument was left out or is an empty argument. */
export function isMissing(value: FormulaValue | undefined): boolean {
  return value === undefined || value === null;
}
