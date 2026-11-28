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

import { type Cell, type SheetCellRef, type SheetId, type Workbook, formatA1, isOfficeError, parseA1Range } from "./engine";
import { MAX_CHECK_CELLS_PER_SHEET, MAX_FINDINGS } from "./limits";
import { SheetIndex } from "./sheet-index";
import { type SheetCells, cellAt, isBlank, isDateFormat, isNumber, locationOf, readSheetCells } from "./sheet-read";

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

/** What one check run found, and what it could not look at. */
export interface CheckReport {
  findings: Finding[];
  /** Sheets left out because their used area is larger than the scan bound. Their cells were not checked. */
  skipped: Array<{ sheet: SheetId; name: string }>;
  /** True when the run stopped at the most findings it reports: cells after the last one were not checked. */
  capped: boolean;
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

interface LabelIndex {
  /** Lower-case row label to the formula or number cells under a "Total" column header. */
  totals: Map<string, Array<SheetCellRef & { value: number; location: string }>>;
}

function indexTotals(all: readonly SheetIndex[]): LabelIndex {
  const totals: LabelIndex["totals"] = new Map();
  for (const index of all) {
    const data = index.data;
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        const cell = data.cells[r]![c]!;
        if (cell.formula === null || typeof cell.value !== "number") continue;
        const row = data.origin.row + r;
        const col = data.origin.col + c;
        const header = index.columnHeader(row, col);
        const label = index.rowLabel(row, col);
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

function checkTypedNumber(sheet: SheetIndex, isDate: (cell: Cell) => boolean, row: number, col: number, index: LabelIndex, out: Finding[]): void {
  const data = sheet.data;
  const cell = cellAt(data, row, col);
  if (!isNumber(cell) || cell.formula !== null || isDate(cell)) return;
  const label = sheet.rowLabel(row, col);
  const header = sheet.columnHeader(row, col);
  const labelledTotal = (label !== null && TOTAL_WORD.test(label)) || (header !== null && TOTAL_WORD.test(header));
  const surrounded = amongFormulas(data, row, col);
  if (!labelledTotal && !surrounded) return;
  const base = { sheet: data.sheet, sheetName: data.name, row, col, location: locationOf(data.name, row, col), actual: cell.value };
  const what = labelledTotal ? "a typed-in total" : "a typed-in number among formulas";
  out.push({ ...base, kind: "hardcoded", message: `${base.location} is ${what}; it will not update when its inputs change.` });
  if (!labelledTotal) return;

  // What the total should be: the block it closes, else the matching formula total elsewhere.
  const totalsColumn = header !== null && TOTAL_WORD.test(header);
  const block = sheet.runBefore(row, col, totalsColumn ? "row" : "col");
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

/** Addresses of left-out numbers named in a finding; one more says "and more". */
const MAX_MISSED_NAMED = 5;

function checkSumGap(sheet: SheetIndex, row: number, col: number, out: Finding[]): void {
  const data = sheet.data;
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
  // Numbers between the range and the total, then numbers right before the range up to text or an empty cell.
  // The index finds them without walking the line, and no more are looked for than the message names.
  const max = MAX_MISSED_NAMED + 1;
  const between = inRow ? sheet.countedBetween("row", row, range.end.col + 1, col - 1, max) : sheet.countedBetween("col", col, range.end.row + 1, row - 1, max);
  const before = inRow
    ? sheet.countedBackToText("row", row, range.start.col - 1, max - between.length)
    : sheet.countedBackToText("col", col, range.start.row - 1, max - between.length);
  const missed = [...between, ...before].map((at) => formatA1(inRow ? { row, col: at } : { row: at, col }));
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
    message: `${location} adds up ${match[1]!.toUpperCase()} but leaves out ${missed.slice(0, MAX_MISSED_NAMED).join(", ")}${missed.length > MAX_MISSED_NAMED ? " and more" : ""}.`,
  });
}

/** Most cell styles whose date format is remembered during one run; past it the memory starts again. */
const MAX_STYLE_MEMORY = 4096;

/** True for a number shown as a date or time. The answer for each style is worked out once. */
function dateCells(workbook: Workbook): (cell: Cell) => boolean {
  const known = new Map<Cell["styleId"], boolean>();
  return (cell) => {
    if (typeof cell.value !== "number") return false;
    let date = known.get(cell.styleId);
    if (date === undefined) {
      date = isDateFormat(workbook.getStyle(cell.styleId).numberFormat);
      if (known.size >= MAX_STYLE_MEMORY) known.clear();
      known.set(cell.styleId, date);
    }
    return date;
  };
}

/**
 * Runs every check over the workbook. Sheets larger than the scan bound are
 * not read; the report names them, so a run that left some out is never
 * taken for an all-clear.
 */
export function checkWorkbook(workbook: Workbook, options: CheckOptions = {}): CheckReport {
  const wanted = options.sheets === undefined ? null : new Set(options.sheets);
  const isDate = dateCells(workbook);
  const all: SheetIndex[] = [];
  const skipped: CheckReport["skipped"] = [];
  for (const sheet of workbook.listSheets()) {
    const data = readSheetCells(workbook, sheet.id, MAX_CHECK_CELLS_PER_SHEET);
    if (data !== null) all.push(new SheetIndex(data, (cell) => !isDate(cell)));
    else if (workbook.getSheet(sheet.id).dimensions !== null && (wanted === null || wanted.has(sheet.id))) skipped.push({ sheet: sheet.id, name: sheet.name });
  }
  const index = indexTotals(all);
  const out: Finding[] = [];
  let capped = false;
  scan: for (const sheet of all) {
    const data = sheet.data;
    if (wanted !== null && !wanted.has(data.sheet)) continue;
    for (let r = 0; r < data.rows; r++) {
      for (let c = 0; c < data.cols; c++) {
        // A cell is left unchecked only past the bound: then the report says it stopped.
        if (out.length >= MAX_FINDINGS) {
          capped = true;
          break scan;
        }
        const row = data.origin.row + r;
        const col = data.origin.col + c;
        checkTypedNumber(sheet, isDate, row, col, index, out);
        checkSumGap(sheet, row, col, out);
      }
    }
  }
  return { findings: out.slice(0, MAX_FINDINGS), skipped, capped: capped || out.length > MAX_FINDINGS };
}
