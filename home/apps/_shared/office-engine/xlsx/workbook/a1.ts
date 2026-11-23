/** A1 addresses: column labels, cells, ranges and sheet-qualified ranges. */

import type {
  CellAddress,
  CellRange,
  ColumnIndex,
  ColumnLabel,
  FormatA1,
  FormatA1Range,
  ParseA1,
  ParseA1Range,
  ParseSheetRange,
} from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

function invalid(what: string, text: unknown): OfficeError {
  const shown = typeof text === "string" ? text.slice(0, 64) : typeof text;
  return new OfficeError("invalid_argument", `${what}: ${shown}`);
}

export const columnLabel: ColumnLabel = (col) => {
  if (!Number.isInteger(col) || col < 0 || col >= MAX_COLS) throw invalid("not a column index", String(col));
  let label = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
};

/** Column index of a label made of letters only, or -1 when it is not a column of a sheet. */
export function columnIndexOrNegative(label: string): number {
  const length = label.length;
  if (length === 0 || length > 3) return -1;
  let n = 0;
  for (let i = 0; i < length; i++) {
    const code = label.charCodeAt(i) & ~32;
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n > MAX_COLS ? -1 : n - 1;
}

export const columnIndex: ColumnIndex = (label) => {
  const index = typeof label === "string" ? columnIndexOrNegative(label) : -1;
  if (index < 0) throw invalid("not a column label", label);
  return index;
};

const CELL_PATTERN = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
const COLUMN_PATTERN = /^\$?([A-Za-z]{1,3})$/;
const ROW_PATTERN = /^\$?([0-9]{1,7})$/;

function parseCell(text: string): CellAddress | null {
  const match = CELL_PATTERN.exec(text);
  if (match === null) return null;
  const col = columnIndexOrNegative(match[1] as string);
  const row = Number(match[2]) - 1;
  return col < 0 || row < 0 || row >= MAX_ROWS ? null : { row, col };
}

export const parseA1: ParseA1 = (text) => {
  const address = typeof text === "string" ? parseCell(text.trim()) : null;
  if (address === null) throw invalid("not a cell address", text);
  return address;
};

export const formatA1: FormatA1 = (address) => `${columnLabel(address.col)}${rowLabel(address.row)}`;

function rowLabel(row: number): string {
  if (!Number.isInteger(row) || row < 0 || row >= MAX_ROWS) throw invalid("not a row index", String(row));
  return String(row + 1);
}

/** Orders the corners of a rectangle. */
export function normalizeRange(a: CellAddress, b: CellAddress): CellRange {
  return {
    start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
    end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
  };
}

/** Parses a range, or returns null when the text is not one. */
export function tryParseA1Range(text: string): CellRange | null {
  const colon = text.indexOf(":");
  if (colon < 0) {
    const cell = parseCell(text);
    return cell === null ? null : { start: cell, end: { row: cell.row, col: cell.col } };
  }
  const left = text.slice(0, colon);
  const right = text.slice(colon + 1);
  const a = parseCell(left);
  const b = parseCell(right);
  if (a !== null && b !== null) return normalizeRange(a, b);
  const leftCol = COLUMN_PATTERN.exec(left);
  const rightCol = COLUMN_PATTERN.exec(right);
  if (leftCol !== null && rightCol !== null) {
    const c1 = columnIndexOrNegative(leftCol[1] as string);
    const c2 = columnIndexOrNegative(rightCol[1] as string);
    if (c1 < 0 || c2 < 0) return null;
    return normalizeRange({ row: 0, col: c1 }, { row: MAX_ROWS - 1, col: c2 });
  }
  const leftRow = ROW_PATTERN.exec(left);
  const rightRow = ROW_PATTERN.exec(right);
  if (leftRow !== null && rightRow !== null) {
    const r1 = Number(leftRow[1]) - 1;
    const r2 = Number(rightRow[1]) - 1;
    if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) return null;
    return normalizeRange({ row: r1, col: 0 }, { row: r2, col: MAX_COLS - 1 });
  }
  return null;
}

export const parseA1Range: ParseA1Range = (text) => {
  const range = typeof text === "string" ? tryParseA1Range(text.trim()) : null;
  if (range === null) throw invalid("not a cell range", text);
  return range;
};

export const formatA1Range: FormatA1Range = (range) => {
  const start = formatA1(range.start);
  if (range.start.row === range.end.row && range.start.col === range.end.col) return start;
  return `${start}:${formatA1(range.end)}`;
};

/** True when a sheet name can be written in a formula without quotes. */
function isPlainSheetName(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return false;
  if (parseCell(name) !== null) return false;
  if (/^[Rr][0-9]*[Cc][0-9]*$/.test(name)) return false;
  const upper = name.toUpperCase();
  return upper !== "TRUE" && upper !== "FALSE";
}

/** A sheet name as a formula writes it: quoted when needed, with `'` doubled. */
export function quoteSheetName(name: string): string {
  return isPlainSheetName(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

export const parseSheetRange: ParseSheetRange = (text) => {
  if (typeof text !== "string") throw invalid("not a sheet range", text);
  const trimmed = text.trim();
  let sheetName: string | null = null;
  let rest = trimmed;
  if (trimmed.startsWith("'")) {
    // Quoted name: runs to the first quote that is not doubled.
    let i = 1;
    let name = "";
    for (;;) {
      const quote = trimmed.indexOf("'", i);
      if (quote < 0) throw invalid("not a sheet range", text);
      name += trimmed.slice(i, quote);
      if (trimmed.charAt(quote + 1) === "'") {
        name += "'";
        i = quote + 2;
      } else {
        i = quote + 1;
        break;
      }
    }
    if (trimmed.charAt(i) !== "!" || name === "") throw invalid("not a sheet range", text);
    sheetName = name;
    rest = trimmed.slice(i + 1);
  } else {
    const bang = trimmed.lastIndexOf("!");
    if (bang >= 0) {
      sheetName = trimmed.slice(0, bang);
      rest = trimmed.slice(bang + 1);
      if (sheetName === "") throw invalid("not a sheet range", text);
    }
  }
  const range = tryParseA1Range(rest);
  if (range === null) throw invalid("not a sheet range", text);
  return { sheetName, range };
};

/** Checks an address against the sheet bounds. */
export function requireAddress(address: CellAddress): void {
  const row: unknown = (address as { row?: unknown } | null)?.row;
  const col: unknown = (address as { col?: unknown } | null)?.col;
  if (
    typeof row !== "number" ||
    typeof col !== "number" ||
    !Number.isInteger(row) ||
    !Number.isInteger(col) ||
    row < 0 ||
    col < 0 ||
    row >= MAX_ROWS ||
    col >= MAX_COLS
  ) {
    throw new OfficeError("invalid_argument", "cell address is outside the sheet");
  }
}

/** Checks a range and returns it with ordered corners. */
export function requireRange(range: CellRange): CellRange {
  const start = (range as { start?: CellAddress } | null)?.start;
  const end = (range as { end?: CellAddress } | null)?.end;
  if (start === undefined || end === undefined) throw new OfficeError("invalid_argument", "range needs a start and an end");
  requireAddress(start);
  requireAddress(end);
  return normalizeRange(start, end);
}
