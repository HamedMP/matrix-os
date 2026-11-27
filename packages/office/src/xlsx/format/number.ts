/**
 * Numeric sections of a format code: digit placeholders, thousands
 * separators, scaling, percent and scientific notation.
 */

import { type Decimal, type FixedDigits, isZeroDecimal, roundDecimal, shiftDecimal, toDecimal } from "./decimal.js";
import { type FractionPlan, findFractionPlan, renderFraction } from "./fraction.js";
import type { FormatSection, FormatToken } from "./sections.js";

type Digit = "0" | "#" | "?";

interface NumberPlan {
  /** Tokens before the decimal point, with scaling commas removed. */
  intTokens: FormatToken[];
  /** Tokens after the decimal point; null when the section has no point. */
  fracTokens: FormatToken[] | null;
  /** Tokens after `E+` or `E-`; null when the section is not scientific. */
  expTokens: FormatToken[] | null;
  expPlus: boolean;
  intDigits: number;
  fracDigits: number;
  grouping: boolean;
  /** Powers of ten applied before rounding: +2 per percent sign, -3 per scaling comma. */
  shift: number;
  fraction: FractionPlan | null;
}

const plans = new WeakMap<FormatSection, NumberPlan>();

function countDigits(tokens: readonly FormatToken[]): number {
  let count = 0;
  for (const token of tokens) if (token.t === "digit") count++;
  return count;
}

function buildPlan(section: FormatSection): NumberPlan {
  const tokens = section.tokens;
  const fraction = findFractionPlan(tokens);
  const expIndex = tokens.findIndex((token) => token.t === "exp");
  const mantissaRaw = expIndex < 0 ? tokens : tokens.slice(0, expIndex);
  let shift = 0;
  let grouping = false;
  for (const token of tokens) if (token.t === "percent") shift += 2;
  // Commas straight after the last digit placeholder scale by 1000 each.
  let lastDigit = -1;
  for (let i = 0; i < mantissaRaw.length; i++) if ((mantissaRaw[i] as FormatToken).t === "digit") lastDigit = i;
  const mantissa: FormatToken[] = [];
  for (let i = 0; i < mantissaRaw.length; i++) {
    const token = mantissaRaw[i] as FormatToken;
    if (token.t === "comma" && lastDigit >= 0 && i > lastDigit && onlyCommasBetween(mantissaRaw, lastDigit, i)) {
      shift -= 3;
      continue;
    }
    mantissa.push(token);
  }
  const pointAt = mantissa.findIndex((token) => token.t === "point");
  const rawInt = pointAt < 0 ? mantissa : mantissa.slice(0, pointAt);
  const fracTokens = pointAt < 0 ? null : mantissa.slice(pointAt + 1);
  // A comma between digit placeholders of the integer part groups thousands.
  let lastIntDigit = -1;
  for (let i = 0; i < rawInt.length; i++) if ((rawInt[i] as FormatToken).t === "digit") lastIntDigit = i;
  const intTokens: FormatToken[] = [];
  let seenDigit = false;
  for (let i = 0; i < rawInt.length; i++) {
    const token = rawInt[i] as FormatToken;
    if (token.t === "digit") seenDigit = true;
    if (token.t === "comma" && seenDigit && i < lastIntDigit) {
      grouping = true;
      continue;
    }
    intTokens.push(token);
  }
  return {
    intTokens,
    fracTokens,
    expTokens: expIndex < 0 ? null : tokens.slice(expIndex + 1),
    expPlus: expIndex >= 0 && (tokens[expIndex] as { plus: boolean }).plus,
    intDigits: countDigits(intTokens),
    fracDigits: fracTokens === null ? 0 : countDigits(fracTokens),
    grouping,
    shift,
    fraction,
  };
}

function onlyCommasBetween(tokens: readonly FormatToken[], from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) if ((tokens[i] as FormatToken).t !== "comma") return false;
  return true;
}

function literalOf(token: FormatToken): string {
  switch (token.t) {
    case "lit":
      return token.v;
    case "percent":
      return "%";
    case "comma":
      return ",";
    case "point":
      return ".";
    case "slash":
      return "/";
    default:
      return "";
  }
}

/** Writes integer digits into the placeholders of `tokens`, right to left. */
function renderInteger(tokens: readonly FormatToken[], int: string, grouping: boolean, placeholders: number): string {
  let digits = int === "0" ? "" : int;
  if (placeholders === 0) {
    // No placeholder to hold them: significant digits go in front of the decimal point.
    let literals = "";
    for (const token of tokens) literals += literalOf(token);
    return literals + digits;
  }
  const parts: string[] = [];
  let remaining = placeholders;
  let written = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as FormatToken;
    if (token.t !== "digit") {
      parts.push(literalOf(token));
      continue;
    }
    remaining--;
    // The leftmost placeholder takes every digit that is left.
    let take = remaining === 0 ? digits : digits.slice(-1);
    digits = remaining === 0 ? "" : digits.slice(0, -1);
    if (take === "") {
      const kind = token.v as Digit;
      if (kind === "#") continue;
      take = kind === "0" ? "0" : " ";
    }
    let piece = "";
    for (let d = take.length - 1; d >= 0; d--) {
      const ch = take.charAt(d);
      if (grouping && ch !== " " && written > 0 && written % 3 === 0) piece = `,${piece}`;
      piece = ch + piece;
      written++;
    }
    parts.push(piece);
  }
  return parts.reverse().join("");
}

function renderFractionDigits(tokens: readonly FormatToken[], frac: string): string {
  let significant = frac.length;
  while (significant > 0 && frac.charCodeAt(significant - 1) === 48) significant--;
  let out = "";
  let index = 0;
  for (const token of tokens) {
    if (token.t !== "digit") {
      out += literalOf(token);
      continue;
    }
    if (index < significant || token.v === "0") out += frac.charAt(index);
    else if (token.v === "?") out += " ";
    index++;
  }
  return out;
}

function renderFixed(plan: NumberPlan, fixed: FixedDigits): string {
  let out = renderInteger(plan.intTokens, fixed.int, plan.grouping, plan.intDigits);
  if (plan.fracTokens !== null) out += `.${renderFractionDigits(plan.fracTokens, fixed.frac)}`;
  return out;
}

function renderScientific(plan: NumberPlan, value: Decimal): string {
  const step = Math.max(1, plan.intDigits);
  let exp = 0;
  let fixed: FixedDigits;
  if (isZeroDecimal(value)) {
    fixed = roundDecimal(value, plan.fracDigits);
  } else {
    exp = Math.floor(value.exp / step) * step;
    fixed = roundDecimal({ digits: value.digits, exp: value.exp - exp }, plan.fracDigits);
    if (fixed.int.length > step) {
      exp += step;
      fixed = roundDecimal({ digits: value.digits, exp: value.exp - exp }, plan.fracDigits);
    }
  }
  const expTokens = plan.expTokens as FormatToken[];
  const sign = exp < 0 ? "-" : plan.expPlus ? "+" : "";
  const power = renderInteger(expTokens, String(Math.abs(exp)), false, countDigits(expTokens));
  return `${renderFixed(plan, fixed)}E${sign}${power === "" ? "0" : power}`;
}

/**
 * Formats a magnitude with a numeric section. The caller adds a minus sign.
 * `abs` is finite and not negative.
 */
export function renderNumberSection(section: FormatSection, abs: number): string {
  let plan = plans.get(section);
  if (plan === undefined) {
    plan = buildPlan(section);
    plans.set(section, plan);
  }
  if (plan.fraction !== null) return renderFraction(plan.fraction, section.tokens, abs);
  const value = shiftDecimal(toDecimal(abs), plan.shift);
  if (plan.expTokens !== null) return renderScientific(plan, value);
  return renderFixed(plan, roundDecimal(value, plan.fracDigits));
}
