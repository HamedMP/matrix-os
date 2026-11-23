/**
 * Part of a sheet as bounded text for a prompt. The format is described on
 * `SheetDescription` in `../api/agent.ts`.
 */

import type { DescribeSheet } from "../api/agent.js";
import type { Cell, CellRange, SheetInfo } from "../api/xlsx.js";
import { OfficeError } from "../errors.js";
import { formatA1, formatA1Range } from "../xlsx/workbook/a1.js";
import { ELLIPSIS, MAX_DESCRIPTION_CHARS, MAX_SCANNED_CELLS } from "./limits.js";
import { singleLine } from "./text.js";

function checkBudget(maxChars: unknown): number {
  if (typeof maxChars !== "number" || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_DESCRIPTION_CHARS) {
    throw new OfficeError("invalid_argument", `maxChars must be a whole number from 1 to ${MAX_DESCRIPTION_CHARS}`);
  }
  return maxChars;
}

function isAddress(value: unknown): value is { row: number; col: number } {
  if (typeof value !== "object" || value === null) return false;
  const { row, col } = value as { row: unknown; col: unknown };
  return typeof row === "number" && Number.isInteger(row) && row >= 0 && typeof col === "number" && Number.isInteger(col) && col >= 0;
}

/** The requested rectangle cut down to the used part of the sheet, or null when they do not meet. */
function clip(range: CellRange | null, used: CellRange | null): CellRange | null {
  if (range !== null && (!isAddress(range.start) || !isAddress(range.end) || range.start.row > range.end.row || range.start.col > range.end.col)) {
    throw new OfficeError("invalid_argument", "the range is not a rectangle of the sheet");
  }
  if (used === null) return null;
  if (range === null) return used;
  const start = { row: Math.max(range.start.row, used.start.row), col: Math.max(range.start.col, used.start.col) };
  const end = { row: Math.min(range.end.row, used.end.row), col: Math.min(range.end.col, used.end.col) };
  return start.row > end.row || start.col > end.col ? null : { start, end };
}

/** What a description shows for a cell: the formula and its result, or the display text. */
export function cellText(cell: Cell): string {
  const display = singleLine(cell.display);
  return cell.formula === null ? display : `=${singleLine(cell.formula)} => ${display}`;
}

function header(sheet: SheetInfo, range: CellRange): string {
  return `Sheet "${singleLine(sheet.name)}" ${formatA1Range(range)}`;
}

export const describeSheet: DescribeSheet = (workbook, sheetId, range, options) => {
  const maxChars = checkBudget(options?.maxChars);
  const sheet = workbook.getSheet(sheetId);
  const area = clip(range, sheet.dimensions);
  if (area === null) {
    // Nothing to describe: the range named is returned as it was asked for.
    const asked = range ?? { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } };
    const title = header(sheet, asked);
    return { text: title.length <= maxChars ? title : "", truncated: false, range: asked };
  }
  // The header names the described range, which is never longer in text than the whole area.
  const reserved = header(sheet, area).length;
  const width = area.end.col - area.start.col + 1;
  let body = "";
  let lastRow = area.start.row - 1;
  let lastCol = area.end.col;
  let truncated = false;
  let scanned = 0;

  for (let row = area.start.row; row <= area.end.row; row++) {
    scanned += width;
    if (scanned > MAX_SCANNED_CELLS) {
      truncated = true;
      break;
    }
    const cells = workbook.getRange(sheet.id, { start: { row, col: area.start.col }, end: { row, col: area.end.col } })[0] ?? [];
    let lines = "";
    let fits = true;
    let fittedCol = area.start.col - 1;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as Cell;
      if (cell.value === null && cell.formula === null) continue;
      const line = `\n${formatA1({ row, col: area.start.col + i })}: ${cellText(cell)}`;
      if (reserved + body.length + lines.length + line.length > maxChars) {
        fits = false;
        break;
      }
      lines += line;
      fittedCol = area.start.col + i;
    }
    if (fits) {
      body += lines;
      lastRow = row;
      continue;
    }
    truncated = true;
    if (lastRow < area.start.row && fittedCol >= area.start.col) {
      // Not even the first row fits: the cells of it that do are described, so a caller can go on from there.
      body += lines;
      lastRow = row;
      lastCol = fittedCol;
    }
    break;
  }

  if (lastRow < area.start.row) {
    // Not one cell fits. The first one is cut so that the description is never empty-handed.
    const first = firstCell(workbook, sheet, area);
    const described: CellRange = { start: area.start, end: first === null ? area.start : first.address };
    const title = header(sheet, described);
    if (first === null || title.length > maxChars) return { text: title.length <= maxChars ? title : "", truncated: true, range: described };
    const line = `\n${formatA1(first.address)}: ${cellText(first.cell)}`;
    const room = maxChars - title.length - ELLIPSIS.length;
    return { text: room > 0 ? `${title}${cutText(line, room)}${ELLIPSIS}` : title, truncated: true, range: described };
  }
  const described: CellRange = { start: area.start, end: { row: lastRow, col: lastCol } };
  return { text: header(sheet, described) + body, truncated, range: described };
};

/** The first non-empty cell of the first row of the area that has one, within the scan bound. */
function firstCell(
  workbook: Parameters<DescribeSheet>[0],
  sheet: SheetInfo,
  area: CellRange,
): { address: { row: number; col: number }; cell: Cell } | null {
  const width = area.end.col - area.start.col + 1;
  let scanned = 0;
  for (let row = area.start.row; row <= area.end.row; row++) {
    scanned += width;
    if (scanned > MAX_SCANNED_CELLS) return null;
    const cells = workbook.getRange(sheet.id, { start: { row, col: area.start.col }, end: { row, col: area.end.col } })[0] ?? [];
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as Cell;
      if (cell.value !== null || cell.formula !== null) return { address: { row, col: area.start.col + i }, cell };
    }
  }
  return null;
}

/** The first `length` characters, without half of a surrogate pair at the end. */
function cutText(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}
