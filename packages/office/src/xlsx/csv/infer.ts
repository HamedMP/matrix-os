/**
 * Type inference for CSV fields. Kept conservative: a field becomes a number
 * only when it is written the way a number is stored, so identifiers, phone
 * numbers and codes with leading zeros stay text.
 */

import type { CellValue } from "../../api/xlsx.js";
import { isoToSerial } from "../format/serial.js";

export interface InferredField {
  value: CellValue;
  /** Number format the value needs (`yyyy-mm-dd` for a date), or null. */
  format: string | null;
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/;
/** Digits a number may have before it is treated as an identifier. */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * - `12`, `-3.5`, `1e6`: a number, unless it has more than 15 digits.
 * - `TRUE`, `false`: a boolean.
 * - `2026-03-14` and `2026-03-14 15:09[:26]`: a date serial with a date format.
 * - Everything else is text: leading zeros (`007`), `+1`, `1,250.00`, `50%`,
 *   padded with spaces, and anything starting with `=`.
 */
export function inferField(text: string, date1904: boolean): InferredField {
  if (text === "") return { value: null, format: null };
  const first = text.charCodeAt(0);
  // Fast exit: only digits, `-`, `t` and `f` (either case) start anything typed.
  if (!((first >= 48 && first <= 57) || first === 45 || first === 84 || first === 116 || first === 70 || first === 102)) {
    return { value: text, format: null };
  }
  if (NUMBER.test(text)) {
    const digits = text.replace(/[eE].*$/, "").replace(/[-.]/g, "").replace(/^0+/, "");
    const value = Number(text);
    if (digits.length <= MAX_SIGNIFICANT_DIGITS && Number.isFinite(value)) return { value, format: null };
    return { value: text, format: null };
  }
  if (text.length === 4 || text.length === 5) {
    const upper = text.toUpperCase();
    if (upper === "TRUE") return { value: true, format: null };
    if (upper === "FALSE") return { value: false, format: null };
  }
  if (ISO_DATE.test(text)) {
    const serial = isoToSerial(text, date1904);
    if (serial !== null) return { value: serial, format: "yyyy-mm-dd" };
  } else if (ISO_DATE_TIME.test(text)) {
    const serial = isoToSerial(text, date1904);
    if (serial !== null) return { value: serial, format: "yyyy-mm-dd hh:mm:ss" };
  }
  return { value: text, format: null };
}
