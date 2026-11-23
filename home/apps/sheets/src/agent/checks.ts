/**
 * Deterministic checks for a model's integrity. All in code: the model never
 * decides what is flagged.
 *
 * - `hardcoded`: a typed-in number among formulas (most of its neighbours in
 *   the row or column are formulas), or a typed-in number labelled as a total.
 * - `total-mismatch`: a typed-in total that disagrees with the sum of the
 *   cells it totals (the block above it, the row to its left under a "Total"
 *   header) or with the formula total of the same line elsewhere in the
 *   workbook ("Total revenue" against the "Revenue" row's "Total" column).
 * - `sum-gap`: a `SUM` of part of a row or column that leaves out a number
 *   between the range and the total cell.
 */

import { type SheetCellRef, type SheetId, type Workbook, formatA1, isOfficeError, parseA1Range } from "./engine";
import { MAX_CHECK_CELLS_PER_SHEET, MAX_FINDINGS } from "./limits";
import {
  type SheetCells,
  cellAt,
  columnHeader,
  isBlank,
  isDateCell,
  isNumber,
  isText,
  locationOf,
  readSheetCells,
  rowLabel,
} from "./sheet-read";

export type FindingKind = "hardcoded" | "total-mismatch" | "sum-gap";

export interface Finding {
  kind: FindingKind;
  sheet: SheetId;
  sheetName: string;
  row: number;
  col: number;
  /** `Sheet!A1`. */
  location: string;
  /** One sentence for the owner. Written by code; holds cell labels, addresses and numbers only. */
  message: string;
  /** The value the cell holds, when numeric. */
  actual?: number;
  /** For `total-mismatch`: what the total should be. */
  expected?: number;
  /** Cells the finding compares with. */
  related?: SheetCellRef[];
}

export interface CheckOptions {
  /** Sheets to check; default every sheet. */
  sheets?: readonly SheetId[];
}

const TOTAL_WORD = /\b(?:sub)?totals?\b|\bsum\b/i;
const NEIGHBOURS = 6;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) + 0.005;
}

function numberText(value: number): string {
  return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

/** Formula and typed-number counts among the nearest non-empty cells of a line, both sides. */
function lineStats(data: SheetCells, row: number, col: number, dRow: number, dCol: number): { formulas: number; literals: number } {
  let formulas = 0;
  let literals = 0;
  for (const sign of [-1, 1]) {
    for (let step = 1; step <= NEIGHBOURS; step++) {
      const cell = cellAt(data, row + sign * step * dRow, col + sign * step * dCol);
      if (isBlank(cell)) break;
      if (cell!.formula !== null) formulas += 1;
      else if (typeof cell!.value === "number") literals += 1;
    }
  }
  return { formulas, literals };
}

/** True when the cell's line holds at least three typed numbers and no formula: a row or column of inputs. */
function isInputLine(data: SheetCells, row: number, col: number, dRow: number, dCol: number): boolean {
  const stats = lineStats(data, row, col, dRow, dCol);
  return stats.formulas === 0 && stats.literals >= 2;
}

function amongFormulas(data: SheetCells, row: number, col: number): boolean {
  for (const [dRow, dCol, crossRow, crossCol] of [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
  ] as const) {
    const stats = lineStats(data, row, col, dRow, dCol);
    if (stats.formulas >= 2 && stats.formulas > stats.literals && !isInputLine(data, row, col, crossRow, crossCol)) return true;
  }
  return false;
}

/** Sum of the contiguous numbers before a cell along a line, or null when fewer than two. */
function blockSum(data: SheetCells, row: number, col: number, dRow: number, dCol: number): { sum: number; cells: number } | null {
  let sum = 0;
  let cells = 0;
  for (let step = 1; ; step++) {
    const cell = cellAt(data, row - step * dRow, col - step * dCol);
    if (!isNumber(cell)) break;
    sum += cell.value;
    cells += 1;
  }
  return cells >= 2 ? { sum, cells } : null;
}

interface LabelIndex {
  /** Lower-case row label to the formula or number cells under a "Total" column header. */
  totals: Map<string, Array<SheetCellRef & { value: number; location: string }>>;
}

function indexTotals(all: readonly SheetCells[]): LabelIndex {
  const totals: LabelIndex["totals"] = new Map();
  for (const data of all) {
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        const cell = data.cells[r]![c]!;
        if (cell.formula === null || typeof cell.value !== "number") continue;
        const row = data.origin.row + r;
        const col = data.origin.col + c;
        const header = columnHeader(data, row, col);
        const label = rowLabel(data, row, col);
        if (header === null || label === null || !TOTAL_WORD.test(header)) continue;
        const key = label.toLowerCase();
        const list = totals.get(key) ?? [];
        if (list.length < 8) list.push({ sheet: data.sheet, row, col, value: cell.value, location: locationOf(data.name, row, col) });
        totals.set(key, list);
      }
    }
  }
  return { totals };
}

function strippedLabel(label: string): string {
  return label.replace(/\b(?:grand\s+)?(?:sub)?totals?\b|\bsum\b|\bof\b/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function checkTypedNumber(workbook: Workbook, data: SheetCells, row: number, col: number, index: LabelIndex, out: Finding[]): void {
  const cell = cellAt(data, row, col);
  if (!isNumber(cell) || cell.formula !== null || isDateCell(workbook, cell)) return;
  const label = rowLabel(data, row, col);
  const header = columnHeader(data, row, col);
  const labelledTotal = (label !== null && TOTAL_WORD.test(label)) || (header !== null && TOTAL_WORD.test(header));
  const surrounded = amongFormulas(data, row, col);
  if (!labelledTotal && !surrounded) return;
  const base = { sheet: data.sheet, sheetName: data.name, row, col, location: locationOf(data.name, row, col), actual: cell.value };
  const what = labelledTotal ? "a typed-in total" : "a typed-in number among formulas";
  out.push({ ...base, kind: "hardcoded", message: `${base.location} is ${what}; it will not update when its inputs change.` });
  if (!labelledTotal) return;

  // What the total should be: the block it closes, else the matching formula total elsewhere.
  const totalsColumn = header !== null && TOTAL_WORD.test(header);
  const block = totalsColumn ? blockSum(data, row, col, 0, 1) : blockSum(data, row, col, 1, 0);
  if (block !== null) {
    if (close(block.sum, cell.value)) return;
    const first = totalsColumn ? { row, col: col - block.cells } : { row: row - block.cells, col };
    const last = totalsColumn ? { row, col: col - 1 } : { row: row - 1, col };
    const span = `${formatA1(first)}:${formatA1(last)}`;
    out.push({
      ...base,
      kind: "total-mismatch",
      expected: block.sum,
      message: `${base.location} shows ${numberText(cell.value)} but ${span} adds up to ${numberText(block.sum)}.`,
    });
    return;
  }
  if (label === null) return;
  const key = strippedLabel(label);
  if (key === "") return;
  const match = (index.totals.get(key) ?? []).find((entry) => !(entry.sheet === data.sheet && entry.row === row && entry.col === col));
  if (match === undefined || close(match.value, cell.value)) return;
  out.push({
    ...base,
    kind: "total-mismatch",
    expected: match.value,
    related: [{ sheet: match.sheet, row: match.row, col: match.col }],
    message: `${base.location} shows ${numberText(cell.value)} but ${match.location} calculates ${numberText(match.value)}.`,
  });
}

const SUM_PATTERN = /^\s*SUM\(\s*(\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+)\s*\)\s*$/i;

function checkSumGap(workbook: Workbook, data: SheetCells, row: number, col: number, out: Finding[]): void {
  const cell = cellAt(data, row, col);
  if (cell === null || cell.formula === null) return;
  const match = SUM_PATTERN.exec(cell.formula);
  if (match === null) return;
  let range;
  try {
    range = parseA1Range(match[1]!.replace(/\$/g, ""));
  } catch (error: unknown) {
    // A reference the engine's parser refuses is not a plain range: nothing to compare.
    if (isOfficeError(error)) return;
    throw error;
  }
  const inRow = range.start.row === row && range.end.row === row && range.end.col < col;
  const inCol = range.start.col === col && range.end.col === col && range.end.row < row;
  if (!inRow && !inCol) return;
  const missed: string[] = [];
  const consider = (r: number, c: number): void => {
    const other = cellAt(data, r, c);
    if (isNumber(other) && !isDateCell(workbook, other)) missed.push(formatA1({ row: r, col: c }));
  };
  if (inRow) {
    for (let c = range.end.col + 1; c < col; c++) consider(row, c);
    for (let c = range.start.col - 1; c >= data.origin.col && !isText(cellAt(data, row, c)) && !isBlank(cellAt(data, row, c)); c--) consider(row, c);
  } else {
    for (let r = range.end.row + 1; r < row; r++) consider(r, col);
    for (let r = range.start.row - 1; r >= data.origin.row && !isText(cellAt(data, r, col)) && !isBlank(cellAt(data, r, col)); r--) consider(r, col);
  }
  if (missed.length === 0) return;
  const location = locationOf(data.name, row, col);
  out.push({
    kind: "sum-gap",
    sheet: data.sheet,
    sheetName: data.name,
    row,
    col,
    location,
    actual: typeof cell.value === "number" ? cell.value : undefined,
    message: `${location} adds up ${match[1]!.toUpperCase()} but leaves out ${missed.slice(0, 5).join(", ")}${missed.length > 5 ? " and more" : ""}.`,
  });
}

/** Runs every check over the workbook. Sheets larger than the scan bound are skipped. */
export function checkWorkbook(workbook: Workbook, options: CheckOptions = {}): Finding[] {
  const wanted = options.sheets === undefined ? null : new Set(options.sheets);
  const all: SheetCells[] = [];
  for (const sheet of workbook.listSheets()) {
    const data = readSheetCells(workbook, sheet.id, MAX_CHECK_CELLS_PER_SHEET);
    if (data !== null) all.push(data);
  }
  const index = indexTotals(all);
  const out: Finding[] = [];
  for (const data of all) {
    if (wanted !== null && !wanted.has(data.sheet)) continue;
    for (let r = 0; r < data.rows && out.length < MAX_FINDINGS; r++) {
      for (let c = 0; c < data.cols && out.length < MAX_FINDINGS; c++) {
        const row = data.origin.row + r;
        const col = data.origin.col + c;
        checkTypedNumber(workbook, data, row, col, index, out);
        checkSumGap(workbook, data, row, col, out);
      }
    }
  }
  return out.slice(0, MAX_FINDINGS);
}
