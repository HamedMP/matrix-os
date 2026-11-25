/**
 * Fraction formats: `# ?/?`, `# ??/??`, `?/?` and a fixed denominator such
 * as `# ?/8`.
 */

import type { FormatToken } from "./sections.js";

export interface FractionPlan {
  /** Index of the first numerator placeholder. */
  numeratorStart: number;
  /** Index of the slash. */
  slash: number;
  /** Index after the last denominator token. */
  denominatorEnd: number;
  numeratorDigits: number;
  /** Number of placeholders in the denominator, or 0 for a fixed denominator. */
  denominatorDigits: number;
  fixedDenominator: number | null;
  /** True when placeholders before the numerator show the whole part. */
  hasWhole: boolean;
}

/** Largest denominator searched: four placeholders. */
const MAX_DENOMINATOR = 9999;

export function findFractionPlan(tokens: readonly FormatToken[]): FractionPlan | null {
  const slash = tokens.findIndex((token) => token.t === "slash");
  if (slash <= 0) return null;
  let numeratorStart = slash;
  while (numeratorStart > 0 && (tokens[numeratorStart - 1] as FormatToken).t === "digit") numeratorStart--;
  if (numeratorStart === slash) return null;
  let end = slash + 1;
  let fixed = "";
  let denominatorDigits = 0;
  const first = tokens[end];
  if (first !== undefined && first.t === "lit" && /^[1-9]\d*$/.test(first.v)) {
    fixed = first.v;
    end++;
    while (tokens[end]?.t === "digit" && (tokens[end] as { v: string }).v === "0") {
      fixed += "0";
      end++;
    }
  } else {
    while (tokens[end]?.t === "digit") {
      denominatorDigits++;
      end++;
    }
    if (denominatorDigits === 0) return null;
  }
  let hasWhole = false;
  for (let i = 0; i < numeratorStart; i++) if ((tokens[i] as FormatToken).t === "digit") hasWhole = true;
  return {
    numeratorStart,
    slash,
    denominatorEnd: end,
    numeratorDigits: slash - numeratorStart,
    denominatorDigits,
    fixedDenominator: fixed === "" ? null : Number(fixed),
    hasWhole,
  };
}

/** The fraction with a denominator of at most `maxDenominator` nearest to `value` (0 ≤ value). */
function nearestFraction(value: number, maxDenominator: number): { n: number; d: number } {
  let bestN = Math.round(value);
  let bestD = 1;
  let bestError = Math.abs(value - bestN);
  for (let d = 2; d <= maxDenominator && bestError > 1e-12; d++) {
    const n = Math.round(value * d);
    const error = Math.abs(value - n / d);
    if (error < bestError - 1e-12) {
      bestN = n;
      bestD = d;
      bestError = error;
    }
  }
  return { n: bestN, d: bestD };
}

function literalText(token: FormatToken): string {
  if (token.t === "lit") return token.v;
  if (token.t === "percent") return "%";
  if (token.t === "comma") return ",";
  if (token.t === "point") return ".";
  return "";
}

export function renderFraction(plan: FractionPlan, tokens: readonly FormatToken[], abs: number): string {
  let whole = plan.hasWhole ? Math.floor(abs) : 0;
  const rest = abs - whole;
  let n: number;
  let d: number;
  if (plan.fixedDenominator !== null) {
    d = plan.fixedDenominator;
    n = Math.round(rest * d);
  } else {
    const limit = Math.min(MAX_DENOMINATOR, 10 ** plan.denominatorDigits - 1);
    ({ n, d } = nearestFraction(rest, limit));
  }
  if (plan.hasWhole && n >= d) {
    whole += Math.floor(n / d);
    n %= d;
  }
  let out = "";
  // Whole part: every placeholder before the numerator; the last one carries the digits.
  let wholePlaceholders = 0;
  for (let i = 0; i < plan.numeratorStart; i++) if ((tokens[i] as FormatToken).t === "digit") wholePlaceholders++;
  let seen = 0;
  for (let i = 0; i < plan.numeratorStart; i++) {
    const token = tokens[i] as FormatToken;
    if (token.t !== "digit") {
      out += literalText(token);
      continue;
    }
    seen++;
    if (seen === wholePlaceholders) {
      if (whole !== 0 || n === 0) out += String(whole);
      else if (token.v === "0") out += "0";
      else if (token.v === "?") out += " ";
    } else if (token.v === "0") out += "0";
    else if (token.v === "?") out += " ";
  }
  const width = plan.denominatorDigits === 0 ? String(d).length : plan.denominatorDigits;
  if (n === 0 && plan.hasWhole) {
    out += " ".repeat(plan.numeratorDigits + 1 + width);
  } else {
    out += String(n).padStart(plan.numeratorDigits, " ");
    out += "/";
    out += String(d).padEnd(width, " ");
  }
  for (let i = plan.denominatorEnd; i < tokens.length; i++) out += literalText(tokens[i] as FormatToken);
  return out;
}
