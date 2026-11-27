/**
 * Cutting rectangles out of arrays and references, for INDEX, XLOOKUP and
 * the array functions. A part of a reference stays a reference (its `ref`
 * is set), so that `SUM(INDEX(A1:C9,0,2))` or `A1:XLOOKUP(…)` work.
 */

import type { FormulaArray, FormulaScalar } from "../../../../api/formula.js";
import { valueAt } from "../../eval/reference.js";
import { shapeOf } from "./match.js";

/** Areas up to this many cells are filled out with blanks; larger ones keep only the used part. */
export const MATERIALIZE_LIMIT = 65_536;

/** The rows of an array as plain values: a small reference is padded with blanks to its full bounds. */
export function materialize(array: FormulaArray): FormulaScalar[][] {
  if (array.ref === null) return array.values;
  const shape = shapeOf(array);
  if (shape.rows * shape.cols > MATERIALIZE_LIMIT) return array.values;
  const out: FormulaScalar[][] = [];
  for (let r = 0; r < shape.rows; r += 1) {
    const line: FormulaScalar[] = [];
    for (let c = 0; c < shape.cols; c += 1) line.push(valueAt(array, r, c));
    out.push(line);
  }
  return out;
}

/**
 * The part of an array from row `r0` to `r1` and column `c0` to `c1`
 * (zero-based, inclusive, inside its full shape). A reference gives a
 * reference to that part.
 */
export function sliceArray(array: FormulaArray, r0: number, c0: number, r1: number, c1: number): FormulaArray {
  const ref = array.ref;
  const area = (r1 - r0 + 1) * (c1 - c0 + 1);
  const full = ref === null || area <= MATERIALIZE_LIMIT;
  const lastRow = full ? r1 : Math.min(r1, array.rows - 1);
  const lastCol = full ? c1 : Math.min(c1, array.cols - 1);
  const values: FormulaScalar[][] = [];
  if (lastCol >= c0) {
    for (let r = r0; r <= lastRow; r += 1) {
      const line: FormulaScalar[] = [];
      for (let c = c0; c <= lastCol; c += 1) line.push(valueAt(array, r, c));
      values.push(line);
    }
  }
  const rows = values.length;
  const cols = rows === 0 ? 0 : (values[0] as FormulaScalar[]).length;
  const bounds =
    ref === null
      ? null
      : {
          sheet: ref.sheet,
          startRow: ref.startRow + r0,
          startCol: ref.startCol + c0,
          endRow: ref.startRow + r1,
          endCol: ref.startCol + c1,
        };
  return { kind: "array", rows, cols: rows === 0 ? 0 : cols, values: rows === 0 ? [] : values, ref: bounds };
}
