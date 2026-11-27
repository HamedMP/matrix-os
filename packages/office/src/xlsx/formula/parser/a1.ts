/** A1 notation: column letters, cell and range text, sheet name quoting. */

import type { CellCorner, RangeNode } from "../../../api/formula.js";
import { MAX_COL, MAX_ROW } from "./ast.js";

const CODE_A = 65;

/** Column letters of a zero-based column: 0 is `A`, 26 is `AA`. */
export function columnLabel(col: number): string {
  let n = Math.trunc(col) + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(CODE_A + rem) + label;
    n = (n - 1 - rem) / 26;
  }
  return label;
}

/** Zero-based column of column letters in any case, or -1 when they are not a column of a sheet. */
export function columnIndex(label: string): number {
  if (label.length === 0 || label.length > 3) return -1;
  let n = 0;
  for (let i = 0; i < label.length; i += 1) {
    const code = label.charCodeAt(i) & ~32;
    if (code < CODE_A || code > CODE_A + 25) return -1;
    n = n * 26 + (code - CODE_A + 1);
  }
  return n - 1 > MAX_COL ? -1 : n - 1;
}

/** `$A$1` for a corner. */
export function cellText(corner: CellCorner): string {
  return `${corner.colAbsolute ? "$" : ""}${columnLabel(corner.col)}${corner.rowAbsolute ? "$" : ""}${corner.row + 1}`;
}

/** `A1:B2`, `A:C` or `2:5` for a range, without the sheet. */
export function rangeText(range: Pick<RangeNode, "shape" | "start" | "end">): string {
  const { start, end } = range;
  if (range.shape === "columns") {
    return `${start.colAbsolute ? "$" : ""}${columnLabel(start.col)}:${end.colAbsolute ? "$" : ""}${columnLabel(end.col)}`;
  }
  if (range.shape === "rows") {
    return `${start.rowAbsolute ? "$" : ""}${start.row + 1}:${end.rowAbsolute ? "$" : ""}${end.row + 1}`;
  }
  return `${cellText(start)}:${cellText(end)}`;
}

const PLAIN_SHEET_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u;
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}[0-9]+$/;
const LOOKS_LIKE_R1C1 = /^[Rr][0-9]*[Cc][0-9]*$/;

/** True when a sheet name must be written in single quotes. */
export function sheetNameNeedsQuotes(name: string): boolean {
  if (!PLAIN_SHEET_NAME.test(name)) return true;
  if (LOOKS_LIKE_CELL.test(name) || LOOKS_LIKE_R1C1.test(name)) return true;
  const upper = name.toUpperCase();
  return upper === "TRUE" || upper === "FALSE";
}

/** A sheet name as written in a formula: quoted when needed, with `'` doubled. */
export function quoteSheetName(name: string): string {
  return sheetNameNeedsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

/** `Sheet1!` or `'My sheet'!`, or the empty string for no sheet. */
export function sheetPrefix(sheet: string | null): string {
  return sheet === null ? "" : `${quoteSheetName(sheet)}!`;
}

/** `Jan:Mar!` or `'Q 1:Q 4'!` for a span of sheets. */
export function sheetSpanPrefix(startSheet: string, endSheet: string): string {
  if (sheetNameNeedsQuotes(startSheet) || sheetNameNeedsQuotes(endSheet)) {
    return `'${startSheet.replace(/'/g, "''")}:${endSheet.replace(/'/g, "''")}'!`;
  }
  return `${startSheet}:${endSheet}!`;
}

/** True when two sheet names are the same sheet: names compare without regard to case. */
export function sameSheet(a: string, b: string): boolean {
  return a === b || a.toUpperCase() === b.toUpperCase();
}

/** True when a zero-based row and column are on a sheet. */
export function inSheet(row: number, col: number): boolean {
  return row >= 0 && row <= MAX_ROW && col >= 0 && col <= MAX_COL;
}

/**
 * Orders the corners of a range so that `start` is the top-left one. Each
 * `$` marker stays with its row or column.
 */
export function normalizeCorners(a: CellCorner, b: CellCorner): { start: CellCorner; end: CellCorner } {
  const rowsInOrder = a.row <= b.row;
  const colsInOrder = a.col <= b.col;
  const top = rowsInOrder ? a : b;
  const bottom = rowsInOrder ? b : a;
  const left = colsInOrder ? a : b;
  const right = colsInOrder ? b : a;
  return {
    start: { row: top.row, col: left.col, rowAbsolute: top.rowAbsolute, colAbsolute: left.colAbsolute },
    end: { row: bottom.row, col: right.col, rowAbsolute: bottom.rowAbsolute, colAbsolute: right.colAbsolute },
  };
}
