/** Formatting of list counters and note marks: decimal, letters and roman numerals. */

import type { NumberingFormat } from "../../api/docx-model.js";

const ROMAN: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** Upper-case roman numeral; values outside 1 to 3999 fall back to decimal. */
export function toRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  let rest = value;
  let text = "";
  for (const [amount, symbol] of ROMAN) {
    while (rest >= amount) {
      text += symbol;
      rest -= amount;
    }
  }
  return text;
}

/**
 * Letter numbering as word processors do it: `a` to `z`, then `aa`, `bb`, …,
 * `zz`, then `aaa`. Values below 1 fall back to decimal.
 */
export function toLetters(value: number): string {
  if (!Number.isInteger(value) || value < 1) return String(value);
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  const repeat = Math.min(Math.floor((value - 1) / 26) + 1, 32);
  return letter.repeat(repeat);
}

function ordinalSuffix(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return "th";
  switch (value % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/** Formats one counter with a `w:numFmt` value. Unknown formats are written as decimal. */
export function formatCounter(value: number, numFmt: string): string {
  switch (numFmt) {
    case "lowerLetter":
      return toLetters(value);
    case "upperLetter":
      return toLetters(value).toUpperCase();
    case "lowerRoman":
      return toRoman(value).toLowerCase();
    case "upperRoman":
      return toRoman(value);
    case "decimalZero":
      return value >= 0 && value < 10 ? `0${value}` : String(value);
    case "ordinal":
      return `${value}${ordinalSuffix(value)}`;
    case "none":
    case "bullet":
      return "";
    default:
      return String(value);
  }
}

/** Maps a `w:numFmt` value to the contract's format names. */
export function numberingFormatOf(numFmt: string): NumberingFormat {
  switch (numFmt) {
    case "decimal":
    case "lowerLetter":
    case "upperLetter":
    case "lowerRoman":
    case "upperRoman":
    case "bullet":
    case "none":
      return numFmt;
    default:
      return "other";
  }
}
