/**
 * A rectangular view of a function argument with the full size of its
 * reference. A range read from a sheet only holds the used part of the
 * sheet, so `A1:A10` on a sheet with three used rows arrives with three
 * rows; the grid still reports ten rows and reads the rest as blank.
 */

import type { CellProvider, FormulaError, FormulaScalar, FormulaValue } from "../../../../api/formula.js";
import { isArray, isError } from "../../coerce.js";
import { readReference } from "../../eval/reference.js";

/** Last row and column index of a sheet. */
const LAST_ROW = 1_048_575;
const LAST_COL = 16_383;

export interface Grid {
  /** Full size, from the reference bounds when there are any. */
  readonly rows: number;
  readonly cols: number;
  /** Size of the part that holds values; everything beyond is blank. */
  readonly usedRows: number;
  readonly usedCols: number;
  /** The value at a zero-based position; blank beyond the used part. */
  at(row: number, col: number): FormulaScalar;
}

/** A grid over a value: a scalar is one cell, an array keeps its reference size. */
export function gridOf(value: FormulaValue): Grid {
  if (!isArray(value)) {
    return { rows: 1, cols: 1, usedRows: 1, usedCols: 1, at: () => value };
  }
  const ref = value.ref;
  const rows = ref === null ? value.rows : ref.endRow - ref.startRow + 1;
  const cols = ref === null ? value.cols : ref.endCol - ref.startCol + 1;
  const usedRows = Math.min(rows, value.rows);
  const usedCols = Math.min(cols, value.cols);
  return {
    rows,
    cols,
    usedRows,
    usedCols,
    at: (row, col) =>
      row < usedRows && col < usedCols ? ((value.values[row] as FormulaScalar[])[col] as FormulaScalar) : null,
  };
}

/**
 * A grid of the given size that starts at the top-left cell of `value`, the
 * way SUMIF and AVERAGEIF stretch or shrink their sum range to the size of
 * the criteria range. A reference of another size is read again from the
 * sheet; a computed array reads blank beyond its own size.
 */
export function resizedGrid(
  value: FormulaValue,
  rows: number,
  cols: number,
  provider: CellProvider,
): Grid | FormulaError {
  const grid = gridOf(value);
  if (grid.rows === rows && grid.cols === cols) return grid;
  if (!isArray(value) || value.ref === null) {
    return {
      rows,
      cols,
      usedRows: Math.min(rows, grid.usedRows),
      usedCols: Math.min(cols, grid.usedCols),
      at: (row, col) => (row < grid.rows && col < grid.cols ? grid.at(row, col) : null),
    };
  }
  const ref = value.ref;
  const bounds = {
    sheet: ref.sheet,
    startRow: ref.startRow,
    startCol: ref.startCol,
    endRow: Math.min(LAST_ROW, ref.startRow + rows - 1),
    endCol: Math.min(LAST_COL, ref.startCol + cols - 1),
  };
  const reread = readReference(provider, bounds);
  if (isError(reread)) return reread;
  const inner = gridOf(reread);
  return {
    rows,
    cols,
    usedRows: Math.min(rows, inner.usedRows),
    usedCols: Math.min(cols, inner.usedCols),
    at: (row, col) => (row < inner.rows && col < inner.cols ? inner.at(row, col) : null),
  };
}

/** True when every grid has the same number of rows and columns. */
export function sameShape(grids: readonly Grid[]): boolean {
  const first = grids[0];
  if (first === undefined) return true;
  return grids.every((grid) => grid.rows === first.rows && grid.cols === first.cols);
}

/** The used part shared by grids of one shape: beyond it every grid is blank. */
export function usedRegion(grids: readonly Grid[]): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const grid of grids) {
    if (grid.usedRows > rows) rows = grid.usedRows;
    if (grid.usedCols > cols) cols = grid.usedCols;
  }
  return { rows, cols };
}
