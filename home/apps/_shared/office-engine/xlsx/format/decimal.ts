/**
 * Decimal arithmetic on the 15 significant digits a spreadsheet shows.
 *
 * Binary floating point cannot round `1.005` to two places correctly
 * (`toFixed` gives `1.00`). Formatting therefore works on the decimal digits
 * of the value: `digits[0].digits[1…] × 10^exp`.
 */

export interface Decimal {
  /** Significant digits without trailing zeros; `"0"` for zero. */
  digits: string;
  /** Power of ten of the first digit. */
  exp: number;
}

/** The 15 significant decimal digits of a non-negative finite number. */
export function toDecimal(abs: number): Decimal {
  if (abs === 0) return { digits: "0", exp: 0 };
  const text = abs.toExponential(14);
  const e = text.indexOf("e");
  let digits = text.charAt(0) + text.slice(2, e);
  let end = digits.length;
  while (end > 1 && digits.charCodeAt(end - 1) === 48) end--;
  digits = digits.slice(0, end);
  return { digits, exp: Number(text.slice(e + 1)) };
}

/** Multiplies by `10^by`. */
export function shiftDecimal(value: Decimal, by: number): Decimal {
  return value.digits === "0" ? value : { digits: value.digits, exp: value.exp + by };
}

export function isZeroDecimal(value: Decimal): boolean {
  return value.digits === "0";
}

/** Adds one to a string of decimal digits. */
function increment(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits.charCodeAt(i) === 57) i--;
  if (i < 0) return `1${"0".repeat(digits.length)}`;
  return digits.slice(0, i) + String.fromCharCode(digits.charCodeAt(i) + 1) + "0".repeat(digits.length - 1 - i);
}

export interface FixedDigits {
  /** Integer digits without leading zeros; `"0"` when the integer part is zero. */
  int: string;
  /** Exactly `decimals` fraction digits. */
  frac: string;
}

/** Longest digit string built for one value; a larger magnitude keeps its leading digits only. */
const MAX_FIXED_DIGITS = 400;

/** Rounds half away from zero to `decimals` fraction digits. */
export function roundDecimal(value: Decimal, decimals: number): FixedDigits {
  const places = Math.max(0, Math.min(decimals, 30));
  if (value.digits === "0" || value.exp < -(places + 1)) return { int: "0", frac: "0".repeat(places) };
  // `all` holds the digits with the decimal point after `point` of them.
  let all = value.digits;
  let point = Math.min(value.exp + 1, MAX_FIXED_DIGITS);
  if (point <= 0) {
    all = "0".repeat(1 - point) + all;
    point = 1;
  }
  const needed = point + places + 1;
  if (all.length < needed) all += "0".repeat(needed - all.length);
  let kept = all.slice(0, point + places);
  if (all.charCodeAt(point + places) >= 53) {
    const bumped = increment(kept);
    if (bumped.length > kept.length) point++;
    kept = bumped;
  }
  let start = 0;
  while (start < point - 1 && kept.charCodeAt(start) === 48) start++;
  return { int: kept.slice(start, point), frac: kept.slice(point) };
}

/** True when every digit is zero. */
export function isZeroFixed(value: FixedDigits): boolean {
  return /^0*$/.test(value.int) && /^0*$/.test(value.frac);
}
