/** Turning what a formula evaluates to into the value its cell stores. */

import type { FormulaError, FormulaScalar, FormulaValue } from "../../api/formula.js";
import type { CellValue } from "../../api/xlsx.js";
import type { CalcNode } from "./calc-graph.js";

export function errorValue(code: FormulaError["code"]): FormulaError {
  return { kind: "error", code };
}

/** A calculated scalar as a cell stores it: blank is 0 and a number that is not finite is an error. */
function scalarValue(value: FormulaScalar): CellValue {
  if (value === null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : errorValue("#NUM!");
  if (typeof value === "object") return errorValue(value.code);
  return value;
}

/**
 * The value an array formula shows `rowOffset` rows and `colOffset` columns
 * from its first cell. One row or one column of results is repeated over
 * the range; a cell beyond the results shows `#N/A`.
 */
export function arrayCellValue(result: FormulaValue, rowOffset: number, colOffset: number): CellValue {
  if (result === null || typeof result !== "object" || result.kind !== "array") return scalarValue(result);
  const ref = result.ref;
  const rows = ref === null ? result.rows : ref.endRow - ref.startRow + 1;
  const cols = ref === null ? result.cols : ref.endCol - ref.startCol + 1;
  const r = rows === 1 ? 0 : rowOffset;
  const c = cols === 1 ? 0 : colOffset;
  if (r >= rows || c >= cols) return errorValue("#N/A");
  return scalarValue(result.values[r]?.[c] ?? null);
}

/** Reduces a formula result to the one value its cell shows. */
export function toCellValue(result: FormulaValue, node: CalcNode): CellValue {
  let value: FormulaScalar;
  if (result !== null && typeof result === "object" && result.kind === "array") {
    // A range result shows the value on the formula's own row or column; any other array shows its first value.
    let r = 0;
    let c = 0;
    const ref = result.ref;
    if (ref !== null) {
      if (ref.startCol === ref.endCol && node.row >= ref.startRow && node.row <= ref.endRow) r = node.row - ref.startRow;
      else if (ref.startRow === ref.endRow && node.col >= ref.startCol && node.col <= ref.endCol) c = node.col - ref.startCol;
      else if (ref.startRow !== ref.endRow || ref.startCol !== ref.endCol) return errorValue("#VALUE!");
    }
    value = result.values[r]?.[c] ?? null;
  } else {
    value = result;
  }
  return scalarValue(value);
}
