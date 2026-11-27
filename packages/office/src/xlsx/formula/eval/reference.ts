/**
 * References at evaluation time: bounds of reference nodes, reading cells
 * and ranges from a {@link CellProvider}, and picking the one value a cell
 * shows from a reference or array result.
 *
 * Function libraries use these for functions that work on references
 * (ROW, COLUMN, OFFSET, INDEX, INDIRECT).
 */

import type {
  CellNode,
  CellProvider,
  FormulaArray,
  FormulaAst,
  FormulaError,
  FormulaScalar,
  FormulaValue,
  RangeBounds,
  RangeNode,
} from "../../../api/formula.js";
import { ERR, isArray, isError, makeError } from "../coerce.js";
import { sameSheet } from "../parser/a1.js";
import { MAX_COL, MAX_ROW } from "../parser/ast.js";

/** The bounds of a cell or range node. `sheet` is used for a node without a sheet name. */
export function boundsOfNode(node: CellNode | RangeNode, sheet: string): RangeBounds {
  const target = node.sheet ?? sheet;
  if (node.type === "cell") {
    return { sheet: target, startRow: node.row, startCol: node.col, endRow: node.row, endCol: node.col };
  }
  return {
    sheet: target,
    startRow: node.start.row,
    startCol: node.start.col,
    endRow: node.end.row,
    endCol: node.end.col,
  };
}

/** How many defined names {@link writtenBounds} follows inside one another. */
const MAX_WRITTEN_NAME_DEPTH = 8;

/**
 * The bounds a reference argument names, found without reading its cells:
 * a cell or range on `sheet` (in parentheses or not), or a defined name for
 * one. Null for anything else, a reference to another sheet included (it is
 * evaluated, so a sheet that does not exist still gives its error).
 *
 * A function that uses only where a reference points (ROW, the start of
 * OFFSET) takes the bounds from here, so the calculation does not count the
 * cells as read and a formula may name its own cell.
 */
export function writtenBounds(node: FormulaAst, provider: CellProvider, sheet: string, depth = 0): RangeBounds | null {
  let inner = node;
  while (inner.type === "paren") inner = inner.inner;
  if (inner.type === "cell" || inner.type === "range") {
    return inner.sheet === null || sameSheet(inner.sheet, sheet) ? boundsOfNode(inner, sheet) : null;
  }
  if (inner.type !== "name" || depth >= MAX_WRITTEN_NAME_DEPTH) return null;
  const resolution = provider.resolveName(inner.name, inner.sheet ?? sheet);
  if (resolution === null || resolution.kind !== "formula") return null;
  return writtenBounds(resolution.ast, provider, resolution.sheet, depth + 1);
}

/** True when the bounds lie on a sheet and are ordered. */
export function validBounds(bounds: RangeBounds): boolean {
  return (
    Number.isInteger(bounds.startRow) &&
    Number.isInteger(bounds.startCol) &&
    Number.isInteger(bounds.endRow) &&
    Number.isInteger(bounds.endCol) &&
    bounds.startRow >= 0 &&
    bounds.startCol >= 0 &&
    bounds.endRow >= bounds.startRow &&
    bounds.endCol >= bounds.startCol &&
    bounds.endRow <= MAX_ROW &&
    bounds.endCol <= MAX_COL
  );
}

/** Number of cells inside bounds. */
export function boundsArea(bounds: RangeBounds): number {
  return (bounds.endRow - bounds.startRow + 1) * (bounds.endCol - bounds.startCol + 1);
}

/** The smallest rectangle that holds both, or null when they are on different sheets. */
export function boundsUnion(a: RangeBounds, b: RangeBounds): RangeBounds | null {
  if (!sameSheet(a.sheet, b.sheet)) return null;
  return {
    sheet: a.sheet,
    startRow: Math.min(a.startRow, b.startRow),
    startCol: Math.min(a.startCol, b.startCol),
    endRow: Math.max(a.endRow, b.endRow),
    endCol: Math.max(a.endCol, b.endCol),
  };
}

/** The cells both have in common, or null when there are none. */
export function boundsIntersection(a: RangeBounds, b: RangeBounds): RangeBounds | null {
  if (!sameSheet(a.sheet, b.sheet)) return null;
  const startRow = Math.max(a.startRow, b.startRow);
  const startCol = Math.max(a.startCol, b.startCol);
  const endRow = Math.min(a.endRow, b.endRow);
  const endCol = Math.min(a.endCol, b.endCol);
  if (startRow > endRow || startCol > endCol) return null;
  return { sheet: a.sheet, startRow, startCol, endRow, endCol };
}

/** Rows of equal length: a provider that returns ragged rows gets them padded with blanks. */
function padRows(values: FormulaScalar[][]): { rows: FormulaScalar[][]; cols: number } {
  let cols = 0;
  let ragged = false;
  for (let i = 0; i < values.length; i += 1) {
    const length = (values[i] as FormulaScalar[]).length;
    if (i === 0) cols = length;
    else if (length !== cols) {
      ragged = true;
      if (length > cols) cols = length;
    }
  }
  if (!ragged) return { rows: values, cols };
  const rows = values.map((row) => (row.length === cols ? row : [...row, ...new Array<null>(cols - row.length).fill(null)]));
  return { rows, cols };
}

/**
 * Reads a rectangle as a reference value: a `FormulaArray` whose `ref` is
 * the full bounds and whose `values` are what the provider returned (the
 * used part of the sheet). Bounds off the sheet give `#REF!`; the provider's
 * error for an unknown sheet is passed on.
 */
export function readReference(provider: CellProvider, bounds: RangeBounds): FormulaArray | FormulaError {
  if (!validBounds(bounds)) return ERR.REF;
  if (bounds.startRow === bounds.endRow && bounds.startCol === bounds.endCol) {
    const value = provider.getCellValue(bounds.sheet, bounds.startRow, bounds.startCol);
    return { kind: "array", rows: 1, cols: 1, values: [[value]], ref: bounds };
  }
  const values = provider.getRangeValues(bounds);
  if (isError(values)) return values;
  const { rows, cols } = padRows(values);
  if (rows.length === 0 || cols === 0) return { kind: "array", rows: 0, cols: 0, values: [], ref: bounds };
  return { kind: "array", rows: rows.length, cols, values: rows, ref: bounds };
}

/** The bounds a value was read from, or null for a scalar or a computed array. */
export function referenceOf(value: FormulaValue): RangeBounds | null {
  return isArray(value) ? value.ref : null;
}

/**
 * The value at a zero-based position inside an array. For a reference, a
 * position inside the bounds but beyond the values read is blank (the unused
 * part of the sheet). Outside the array it is `#REF!`.
 */
export function valueAt(array: FormulaArray, row: number, col: number): FormulaScalar {
  const ref = array.ref;
  const rows = ref === null ? array.rows : ref.endRow - ref.startRow + 1;
  const cols = ref === null ? array.cols : ref.endCol - ref.startCol + 1;
  if (row < 0 || col < 0 || row >= rows || col >= cols) return ERR.REF;
  if (row >= array.rows || col >= array.cols) return null;
  return (array.values[row] as FormulaScalar[])[col] as FormulaScalar;
}

/**
 * The one value a formula cell shows for an evaluation result.
 *
 * - A scalar is itself.
 * - A reference to one cell is that cell.
 * - A reference to part of a column gives the value on the formula's own
 *   row, and part of a row the value in the formula's own column (implicit
 *   intersection); a reference that crosses neither is `#VALUE!`.
 * - A computed array gives its top-left value.
 * - Blank becomes 0: a formula never shows an empty cell.
 */
export function toCellResult(value: FormulaValue, row: number, col: number): Exclude<FormulaScalar, null> {
  let scalar: FormulaScalar;
  if (!isArray(value)) {
    scalar = value;
  } else if (value.ref === null) {
    scalar = value.rows === 0 || value.cols === 0 ? null : valueAt(value, 0, 0);
  } else {
    const ref = value.ref;
    if (ref.startRow === ref.endRow && ref.startCol === ref.endCol) scalar = valueAt(value, 0, 0);
    else if (ref.startCol === ref.endCol && row >= ref.startRow && row <= ref.endRow) scalar = valueAt(value, row - ref.startRow, 0);
    else if (ref.startRow === ref.endRow && col >= ref.startCol && col <= ref.endCol) scalar = valueAt(value, 0, col - ref.startCol);
    else scalar = makeError("#VALUE!", "a range cannot be shown in one cell");
  }
  return scalar === null ? 0 : scalar;
}
