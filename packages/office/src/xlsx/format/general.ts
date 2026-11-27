/**
 * The General number format: as many digits as fit in eleven characters,
 * and scientific notation beyond that.
 */

import { roundDecimal, toDecimal } from "./decimal.js";

function trimFraction(int: string, frac: string): string {
  let end = frac.length;
  while (end > 0 && frac.charCodeAt(end - 1) === 48) end--;
  return end === 0 ? int : `${int}.${frac.slice(0, end)}`;
}

function scientific(abs: number): string {
  const decimal = toDecimal(abs);
  // Six significant digits in the mantissa.
  const mantissa = roundDecimal({ digits: decimal.digits, exp: 0 }, 5);
  let exp = decimal.exp;
  let int = mantissa.int;
  let frac = mantissa.frac;
  if (int.length > 1) {
    frac = int.slice(1) + frac;
    int = int.charAt(0);
    exp++;
  }
  const sign = exp < 0 ? "-" : "+";
  const power = String(Math.abs(exp));
  return `${trimFraction(int, frac)}E${sign}${power.length < 2 ? `0${power}` : power}`;
}

/** Formats a number as the General format shows it in a cell. */
export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return "#NUM!";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const decimal = toDecimal(abs);
  const exp = decimal.exp;
  if (exp >= 11) return sign + scientific(abs);
  const intDigits = exp >= 0 ? exp + 1 : 1;
  const fixed = roundDecimal(decimal, Math.max(0, 10 - intDigits));
  if (fixed.int.length > 11) return sign + scientific(abs);
  const text = trimFraction(fixed.int, fixed.frac);
  if (exp < -4) {
    // A small number is written out only when no digit is lost by doing so.
    const exact = decimal.digits.length <= 10 + exp;
    if (!exact || text === "0") return sign + scientific(abs);
  }
  return sign + text;
}
