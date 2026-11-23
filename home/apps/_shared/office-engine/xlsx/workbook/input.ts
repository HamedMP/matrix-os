/** Turns text a person types into a cell into a typed value. */

import type { CellValue } from "../../api/xlsx.js";
import { isoToSerial } from "../format/serial.js";

export type ParsedInput =
  | { kind: "clear" }
  | { kind: "formula"; text: string }
  /** `format` is the number format the value suggests, applied when the cell has the general format. */
  | { kind: "value"; value: CellValue; format: string | null };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED = /^[+-]?\d{1,3}(?:,\d{3})+(\.\d+)?$/;
const PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;

/**
 * Reads `=…` as a formula, numbers, percentages, ISO dates and TRUE/FALSE as
 * typed values, and everything else as text. A leading `'` forces text.
 */
export function parseCellInput(input: string, date1904: boolean): ParsedInput {
  if (input === "") return { kind: "clear" };
  if (input.startsWith("=") && input.length > 1) return { kind: "formula", text: input.slice(1) };
  if (input.startsWith("'")) return { kind: "value", value: input.slice(1), format: null };
  const text = input.trim();
  const upper = text.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return { kind: "value", value: upper === "TRUE", format: null };
  if (NUMBER.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return { kind: "value", value, format: null };
  }
  const grouped = GROUPED.exec(text);
  if (grouped !== null) {
    const value = Number(text.replace(/,/g, ""));
    if (Number.isFinite(value)) return { kind: "value", value, format: grouped[1] === undefined ? "#,##0" : "#,##0.00" };
  }
  if (PERCENT.test(text)) {
    const digits = text.slice(0, -1);
    const value = Number(digits) / 100;
    if (Number.isFinite(value)) return { kind: "value", value, format: digits.includes(".") ? "0.00%" : "0%" };
  }
  const serial = isoToSerial(text, date1904);
  if (serial !== null) {
    return { kind: "value", value: serial, format: Number.isInteger(serial) ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm:ss" };
  }
  return { kind: "value", value: input, format: null };
}
