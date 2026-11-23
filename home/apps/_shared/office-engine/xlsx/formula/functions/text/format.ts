/**
 * Text functions that turn numbers into text and back: TEXT, VALUE, FIXED
 * and DOLLAR. TEXT uses the workbook's formatter when the evaluation
 * context supplies one and the package's number-format renderer otherwise.
 */

import type { FormulaArg, FormulaError, FormulaValue, FunctionContext, FunctionRegistry } from "../../../../api/formula.js";
import { formatValue } from "../../../format/index.js";
import { ERR, isError, parseNumberText } from "../../coerce.js";
import { registerFunction } from "../../registry.js";
import { parseDateText } from "../date/parse.js";
import { boolArg, boundedText, intArg, numberArg, textArg } from "./args.js";

function text(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const value = args[0] ?? null;
  if (isError(value)) return value;
  const code = textArg(args[1]);
  if (isError(code)) return code;
  let input: number | string | boolean = value === null ? 0 : (value as number | string | boolean);
  if (typeof input === "string") {
    const parsed = parseNumberText(input, { date1904: context.date1904 });
    if (parsed !== null) input = parsed;
  }
  const rendered =
    context.formatValue !== null
      ? context.formatValue(input, code)
      : formatValue(input, code, { date1904: context.date1904 });
  return boundedText(rendered);
}

const PARENTHESIZED = /^\(\s*([^()]+?)\s*\)$/;

/** Converts text that looks like a number, date or time to a number, or returns null. */
export function textToNumber(textValue: string, context: Pick<FunctionContext, "date1904" | "now">): number | null {
  const direct = parseNumberText(textValue, { date1904: context.date1904 });
  if (direct !== null) return direct;
  const negative = PARENTHESIZED.exec(textValue.trim());
  if (negative !== null) {
    const inner = parseNumberText(negative[1] as string, { date1904: context.date1904 });
    if (inner !== null && inner >= 0) return -inner;
  }
  return parseDateText(textValue, context);
}

function value(args: readonly FormulaArg[], context: FunctionContext): FormulaValue {
  const input = args[0] ?? null;
  if (isError(input)) return input;
  if (typeof input === "number") return input;
  if (input === null) return 0;
  if (typeof input === "boolean") return ERR.VALUE;
  const parsed = textToNumber(input as string, context);
  return parsed === null ? ERR.VALUE : parsed;
}

/** Rounds half away from zero to `digits` decimals (negative digits round to tens, hundreds). */
export function roundHalfAway(n: number, digits: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const abs = Math.abs(n);
  const plain = String(abs);
  let rounded: number;
  if (!plain.includes("e") && Math.abs(digits) <= 300) {
    const shifted = Math.round(Number(`${plain}e${digits}`));
    rounded = Number(`${shifted}e${-digits}`);
  } else {
    const factor = 10 ** digits;
    rounded = Math.round(abs * factor) / factor;
  }
  return n < 0 ? -rounded : rounded;
}

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits.charAt(i);
  }
  return out;
}

/** Writes |n| with `decimals` places and optional thousands separators. Null when the number is too large. */
function fixedDigits(n: number, decimals: number, commas: boolean): string | null {
  const rounded = Math.abs(roundHalfAway(n, decimals));
  if (rounded >= 1e21) return null;
  const textValue = rounded.toFixed(Math.max(0, decimals));
  if (!commas) return textValue;
  const dot = textValue.indexOf(".");
  const whole = dot === -1 ? textValue : textValue.slice(0, dot);
  return groupThousands(whole) + (dot === -1 ? "" : textValue.slice(dot));
}

function decimalsArg(value: FormulaValue | undefined): number | FormulaError {
  const decimals = intArg(value, 2);
  if (isError(decimals)) return decimals;
  return decimals > 127 ? ERR.VALUE : decimals;
}

function fixed(args: readonly FormulaArg[]): FormulaValue {
  const n = numberArg(args[0]);
  if (isError(n)) return n;
  const decimals = decimalsArg(args[1]);
  if (isError(decimals)) return decimals;
  const noCommas = boolArg(args[2], false);
  if (isError(noCommas)) return noCommas;
  const body = fixedDigits(n, decimals, !noCommas);
  if (body === null) return ERR.VALUE;
  const negative = roundHalfAway(n, decimals) < 0;
  return negative ? `-${body}` : body;
}

function dollar(args: readonly FormulaArg[]): FormulaValue {
  const n = numberArg(args[0]);
  if (isError(n)) return n;
  const decimals = decimalsArg(args[1]);
  if (isError(decimals)) return decimals;
  const body = fixedDigits(n, decimals, true);
  if (body === null) return ERR.VALUE;
  return roundHalfAway(n, decimals) < 0 ? `($${body})` : `$${body}`;
}

/** Registers TEXT, VALUE, FIXED and DOLLAR. */
export function registerTextFormatFunctions(registry: FunctionRegistry): void {
  registerFunction(registry, "TEXT", text, { minArgs: 2, maxArgs: 2, ranges: "none" });
  registerFunction(registry, "VALUE", value, { minArgs: 1, maxArgs: 1, ranges: "none" });
  registerFunction(registry, "FIXED", fixed, { minArgs: 1, maxArgs: 3, ranges: "none" });
  registerFunction(registry, "DOLLAR", dollar, { minArgs: 1, maxArgs: 2, ranges: "none" });
}
