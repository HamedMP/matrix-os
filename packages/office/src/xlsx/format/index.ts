/**
 * Number format rendering: turns a cell value and a format code into the
 * text a grid shows.
 */

import type { CellValue, FormatValue } from "../../api/xlsx.js";
import { INVALID_DATE_TEXT, renderDateSection } from "./date.js";
import { formatGeneral } from "./general.js";
import { renderNumberSection } from "./number.js";
import { type FormatSection, chooseNumberSection, chooseTextSection, parseFormatCode } from "./sections.js";

export { FIRST_CUSTOM_FORMAT_ID, builtinFormatCode, builtinFormatId } from "./builtin.js";
export { formatGeneral } from "./general.js";
export { INDEXED_COLORS } from "./palette.js";
export { MAX_SERIAL, isoToSerial, partsToSerial, serialToIso, serialToParts } from "./serial.js";
export type { DateParts } from "./serial.js";

export interface FormattedValue {
  text: string;
  /** Colour named by the format section that applied (`[Red]`), as `#rrggbb`, or null. */
  color: string | null;
}

export interface FormatOptions {
  /** True for the 1904 date system. */
  date1904?: boolean;
}

function renderText(section: FormatSection, text: string): string {
  let out = "";
  for (const token of section.tokens) {
    if (token.t === "lit") out += token.v;
    else if (token.t === "text") out += text;
  }
  return out;
}

function renderGeneralSection(section: FormatSection, value: number): string {
  let out = "";
  for (const token of section.tokens) {
    if (token.t === "lit") out += token.v;
    else if (token.t === "general") out += formatGeneral(value);
  }
  return out;
}

function formatNumber(value: number, code: string, date1904: boolean): FormattedValue {
  if (!Number.isFinite(value)) return { text: "#NUM!", color: null };
  const format = parseFormatCode(code);
  const first = format.sections[0] as FormatSection;
  if (format.sections.length === 1 && first.kind === "empty") {
    return { text: formatGeneral(value), color: first.color };
  }
  const chosen = chooseNumberSection(format, value);
  if (chosen === null) return { text: "", color: null };
  const { section, absolute } = chosen;
  const color = section.color;
  switch (section.kind) {
    case "empty":
      return { text: "", color };
    case "general":
      return { text: renderGeneralSection(section, absolute ? Math.abs(value) : value), color };
    case "text":
      return { text: renderText(section, formatGeneral(value)), color };
    case "date":
      return { text: value < 0 ? INVALID_DATE_TEXT : renderDateSection(section, value, date1904), color };
    case "literal":
    case "number": {
      const body = section.kind === "literal" ? renderText(section, "") : renderNumberSection(section, Math.abs(value));
      return { text: value < 0 && !absolute ? `-${body}` : body, color };
    }
  }
}

/** Formats a value and reports the colour of the format section that applied. */
export function formatValueDetailed(value: CellValue, formatCode: string, options?: FormatOptions): FormattedValue {
  if (value === null) return { text: "", color: null };
  if (typeof value === "number") return formatNumber(value, formatCode, options?.date1904 === true);
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", color: null };
  if (typeof value === "string") {
    const section = chooseTextSection(parseFormatCode(formatCode));
    return section === null ? { text: value, color: null } : { text: renderText(section, value), color: section.color };
  }
  return { text: value.code, color: null };
}

export const formatValue: FormatValue = (value, formatCode, options) =>
  formatValueDetailed(value, formatCode, options).text;

/** True when a format code shows a number as a date or a time. */
export function isDateFormat(formatCode: string): boolean {
  const first = parseFormatCode(formatCode).sections[0];
  return first !== undefined && first.kind === "date";
}
