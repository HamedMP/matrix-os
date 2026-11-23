/**
 * Sorting the rows of a range and filtering them.
 *
 * Sorting rewrites the cells of the range: rows keep their values, formulas
 * and looks and move as a whole; relative references in a moved formula
 * move with it. Filtering changes nothing in the file: it gives the rows to
 * hide in this view.
 */

import type { CellRange, CellValue, RawCell } from "../session/engine";
import { adjustFormula } from "./fill";

export interface SortKey {
  /** Column of the sheet to sort by. */
  col: number;
  descending?: boolean;
}

function rank(value: CellValue): number {
  if (value === null || value === "") return 4;
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "boolean") return 2;
  return 3;
}

/**
 * Order of two cell values as spreadsheets sort them: numbers, then text
 * (ignoring case), then FALSE and TRUE, then errors. Empty cells compare
 * equal here; {@link sortOrder} always puts them last.
 */
export function compareValues(a: CellValue, b: CellValue): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
}

/**
 * The order to put rows in: `result[i]` is the index of the row that goes
 * to position `i`. `keys[row]` holds the row's value for each sort key. The
 * sort is stable and empty cells go last in both directions.
 */
export function sortOrder(keys: ReadonlyArray<ReadonlyArray<CellValue>>, descending: ReadonlyArray<boolean>): number[] {
  const order = keys.map((_, index) => index);
  order.sort((x, y) => {
    const kx = keys[x] as ReadonlyArray<CellValue>;
    const ky = keys[y] as ReadonlyArray<CellValue>;
    for (let k = 0; k < descending.length; k++) {
      const a = kx[k] ?? null;
      const b = ky[k] ?? null;
      const blankA = rank(a) === 4;
      const blankB = rank(b) === 4;
      if (blankA !== blankB) return blankA ? 1 : -1;
      const compared = compareValues(a, b);
      if (compared !== 0) return descending[k] === true ? -compared : compared;
    }
    return x - y;
  });
  return order;
}

export interface SortedCell {
  row: number;
  col: number;
  cell: RawCell;
}

/** Most cells one sort moves. */
export const MAX_SORT_CELLS = 500_000;

/**
 * The cells of a range after sorting its rows. Only cells that change are
 * returned. With `hasHeader` the first row stays. Null when the range is too
 * large to sort in one step.
 */
export function planSort(
  range: CellRange,
  keys: readonly SortKey[],
  hasHeader: boolean,
  read: (row: number, col: number) => RawCell,
): SortedCell[] | null {
  const firstRow = range.start.row + (hasHeader ? 1 : 0);
  const rowCount = range.end.row - firstRow + 1;
  const colCount = range.end.col - range.start.col + 1;
  if (rowCount <= 1 || keys.length === 0) return [];
  if (rowCount * colCount > MAX_SORT_CELLS) return null;
  const rows: RawCell[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const row: RawCell[] = [];
    for (let c = 0; c < colCount; c++) row.push(read(firstRow + r, range.start.col + c));
    rows.push(row);
  }
  const keyValues = rows.map((_, r) => keys.map((key) => read(firstRow + r, key.col).value));
  const order = sortOrder(
    keyValues,
    keys.map((key) => key.descending === true),
  );
  const changed: SortedCell[] = [];
  for (let position = 0; position < rowCount; position++) {
    const from = order[position] as number;
    if (from === position) continue;
    const source = rows[from] as RawCell[];
    const target = rows[position] as RawCell[];
    for (let c = 0; c < colCount; c++) {
      const cell = source[c] as RawCell;
      const before = target[c] as RawCell;
      const formula = cell.formula === null ? null : adjustFormula(cell.formula, position - from, 0);
      if (formula === before.formula && cell.styleId === before.styleId && sameValue(cell.value, before.value)) continue;
      changed.push({ row: firstRow + position, col: range.start.col + c, cell: { value: cell.value, formula, styleId: cell.styleId } });
    }
  }
  return changed;
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  return a !== null && b !== null && typeof a === "object" && typeof b === "object" && a.code === b.code;
}

/** One condition of a filter: the rows whose cell in `col` passes stay. */
export interface FilterCriterion {
  col: number;
  /** Display texts that pass. Compared exactly. */
  values?: readonly string[];
  /** Text the display text must contain, ignoring case. */
  contains?: string;
}

export interface FilterSpec {
  /** The filtered range; its first row is the header and always stays. */
  range: CellRange;
  criteria: readonly FilterCriterion[];
}

/** Most rows one filter looks at. */
export const MAX_FILTER_ROWS = 1_048_576;

/** The rows of the range a filter hides. `display` gives the text a cell shows. */
export function filterHiddenRows(spec: FilterSpec, display: (row: number, col: number) => string): Set<number> {
  const hidden = new Set<number>();
  if (spec.criteria.length === 0) return hidden;
  const tests = spec.criteria.map((criterion) => {
    const allowed = criterion.values === undefined ? null : new Set(criterion.values);
    const needle = criterion.contains === undefined || criterion.contains === "" ? null : criterion.contains.toLowerCase();
    return { col: criterion.col, allowed, needle };
  });
  const last = Math.min(spec.range.end.row, spec.range.start.row + MAX_FILTER_ROWS);
  for (let row = spec.range.start.row + 1; row <= last; row++) {
    for (const test of tests) {
      const text = display(row, test.col);
      if ((test.allowed !== null && !test.allowed.has(text)) || (test.needle !== null && !text.toLowerCase().includes(test.needle))) {
        hidden.add(row);
        break;
      }
    }
  }
  return hidden;
}

/** The distinct display texts of a column below the header, in order of first use, for a filter menu. */
export function distinctValues(range: CellRange, col: number, display: (row: number, col: number) => string, limit = 500): string[] {
  const seen = new Set<string>();
  for (let row = range.start.row + 1; row <= range.end.row && seen.size < limit; row++) seen.add(display(row, col));
  return [...seen];
}
