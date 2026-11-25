/** Reading and writing cells of the model: the one place where cell content changes. */

import type { Cell, CellRange, CellStylePatch, CellValue } from "../../api/xlsx.js";
import { OfficeError } from "../../errors.js";
import { formatValue } from "../format/index.js";
import { arrayRangeAt, invalidateArrayRanges } from "./arrays.js";
import { arrayFormulaRange, callsUnknownFunction } from "./calc-graph.js";
import type { CellMutation, RawCell } from "./internals.js";
import {
  type CellRec,
  DIRTY_CONTENT,
  DIRTY_EDIT,
  DIRTY_STYLE,
  type RowRec,
  type SheetModel,
  type WorkbookState,
  cellKey,
} from "./model.js";
import {
  MAX_CELL_TEXT,
  copyValue,
  dropCalcChain,
  invalidateGraph,
  notify,
  parseCached,
  sameValue,
} from "./state.js";
import { renameTableColumn } from "./tables.js";
import { applyStylePatch } from "./style-write.js";

const ERROR_CODES: ReadonlySet<string> = new Set(["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#N/A", "#NUM!", "#NULL!"]);
/** Most cells one `setStyle` or `setRange` call may touch. */
const MAX_RANGE_CELLS = 2_000_000;
const EMPTY: RawCell = Object.freeze({ value: null, formula: null, styleId: 0 });

export function findCell(sheet: SheetModel, row: number, col: number): CellRec | undefined {
  return sheet.rows.get(row)?.cells.get(col);
}

export function readRaw(sheet: SheetModel, row: number, col: number): RawCell {
  const cell = findCell(sheet, row, col);
  return cell === undefined ? { ...EMPTY } : { value: copyValue(cell.value), formula: cell.formula, styleId: cell.styleId };
}

/** Checks a value given by a caller and returns it in the form the model stores. */
export function checkValue(value: CellValue): CellValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OfficeError("invalid_argument", "a cell number must be finite");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_CELL_TEXT) throw new OfficeError("invalid_argument", "cell text is longer than 32767 characters");
    return value;
  }
  const code: unknown = (value as { code?: unknown }).code;
  if ((value as { kind?: unknown }).kind === "error" && typeof code === "string" && ERROR_CODES.has(code)) {
    return { kind: "error", code: value.code };
  }
  throw new OfficeError("invalid_argument", "not a cell value");
}

export function ensureRow(sheet: SheetModel, index: number): RowRec {
  let row = sheet.rows.get(index);
  if (row === undefined) {
    row = { index, el: null, cells: new Map(), height: null, hidden: false, dirty: true };
    sheet.rows.set(index, row);
    sheet.rowSetDirty = true;
    sheet.dirty = true;
  }
  return row;
}

function markEdited(state: WorkbookState, sheet: SheetModel, row: number, col: number): void {
  let edited = state.calc.edited.get(sheet);
  if (edited === undefined) {
    edited = new Set();
    state.calc.edited.set(sheet, edited);
  }
  edited.add(cellKey(row, col));
}

/**
 * Replaces value, formula and style of a cell. Returns false when nothing
 * changed. `reason` names the mutation for the listeners, or is null to tell
 * no one. `keepExtra` keeps the array formula attributes of the cell, for a
 * rewrite of its text.
 */
export function writeCell(
  state: WorkbookState,
  sheet: SheetModel,
  row: number,
  col: number,
  next: RawCell,
  reason: CellMutation["reason"] | null,
  keepExtra = false,
): boolean {
  let rowRec = sheet.rows.get(row);
  const cell = rowRec?.cells.get(col);
  const before: RawCell = cell === undefined ? EMPTY : { value: cell.value, formula: cell.formula, styleId: cell.styleId };
  const formulaChanged = before.formula !== next.formula;
  const contentChanged = formulaChanged || !sameValue(before.value, next.value);
  const styleChanged = before.styleId !== next.styleId;
  if (!contentChanged && !styleChanged) return false;
  // The cell holds an array formula: whatever happens to it, the ranges of the sheet are looked up again.
  if (cell !== undefined && cell.extra !== null) invalidateArrayRanges(sheet);
  const wasCounted = before.value !== null || before.formula !== null;
  const isCounted = next.value !== null || next.formula !== null;
  if (isCounted && !wasCounted && state.cellCount >= state.maxCells) {
    throw new OfficeError("limit_exceeded", "the workbook has more cells than the limit allows", {
      details: { maxCells: state.maxCells },
    });
  }
  if (!isCounted && next.styleId === 0) {
    if (cell !== undefined && rowRec !== undefined) {
      rowRec.cells.delete(col);
      rowRec.dirty = true;
      if (cell.shared >= 0) sheet.unshare = true;
    }
  } else {
    if (rowRec === undefined) rowRec = ensureRow(sheet, row);
    if (cell === undefined) {
      rowRec.cells.set(col, {
        value: next.value,
        formula: next.formula,
        styleId: next.styleId,
        el: null,
        dirty: DIRTY_CONTENT | DIRTY_STYLE,
        shared: -1,
        extra: null,
      });
    } else {
      cell.value = next.value;
      cell.formula = next.formula;
      cell.styleId = next.styleId;
      if (contentChanged) {
        cell.dirty |= DIRTY_CONTENT;
        if (cell.shared >= 0) sheet.unshare = true;
        if (!keepExtra) {
          cell.extra = null;
          cell.dirty |= DIRTY_EDIT;
        }
      }
      if (styleChanged) cell.dirty |= DIRTY_STYLE;
    }
    rowRec.dirty = true;
  }
  state.cellCount += (isCounted ? 1 : 0) - (wasCounted ? 1 : 0);
  sheet.dirty = true;
  sheet.dimensions = undefined;
  if (contentChanged) {
    // The header cell of a table and the name of its column are one thing to other software.
    renameTableColumn(sheet, row, col, next.value);
    markEdited(state, sheet, row, col);
    if (formulaChanged) {
      invalidateGraph(state);
      dropCalcChain(state);
    }
  }
  if (reason !== null && state.listeners.length > 0) {
    notify(state, {
      sheet: sheet.id,
      row,
      col,
      reason,
      before: { value: copyValue(before.value), formula: before.formula, styleId: before.styleId },
      after: { value: copyValue(next.value), formula: next.formula, styleId: next.styleId },
    });
  }
  return true;
}

/** True when the engine keeps the stored value of the formula instead of calculating it. */
export function isUnsupportedFormula(state: WorkbookState, cell: CellRec, row: number, col: number): boolean {
  if (cell.formula === null) return false;
  if (cell.extra !== null && arrayFormulaRange(cell, row, col) === null) return true;
  const ast = parseCached(state, cell.formula);
  return ast === null || callsUnknownFunction(state, ast);
}

export function cellView(state: WorkbookState, sheet: SheetModel, row: number, col: number): Cell {
  const cell = findCell(sheet, row, col);
  const pendingChangeId = state.journal === null ? null : state.journal.pendingChangeId(sheet.id, row, col);
  const filled = arrayRangeAt(sheet, row, col);
  const arrayRange = filled === null ? null : { start: { ...filled.start }, end: { ...filled.end } };
  if (cell === undefined) {
    return { value: null, formula: null, styleId: 0, display: "", formulaUnsupported: false, arrayRange, pendingChangeId };
  }
  const styleId = state.styles.clamp(cell.styleId);
  return {
    value: copyValue(cell.value),
    formula: cell.formula,
    styleId,
    display:
      cell.value === null ? "" : formatValue(cell.value, state.styles.numberFormat(styleId), { date1904: state.date1904 }),
    formulaUnsupported: isUnsupportedFormula(state, cell, row, col),
    arrayRange,
    pendingChangeId,
  };
}

export function rangeArea(range: CellRange): number {
  return (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
}

export function requireSmallRange(range: CellRange): void {
  if (rangeArea(range) > MAX_RANGE_CELLS) {
    throw new OfficeError("limit_exceeded", "the range covers more cells than one call may touch", {
      details: { maxCells: MAX_RANGE_CELLS },
    });
  }
}

/** Calls `visit` for every cell record inside the range, in no particular order. */
export function forEachCellIn(
  sheet: SheetModel,
  range: CellRange,
  visit: (cell: CellRec, row: number, col: number) => void,
): void {
  const { start, end } = range;
  const visitRow = (row: RowRec): void => {
    if (end.col - start.col + 1 <= row.cells.size) {
      for (let col = start.col; col <= end.col; col++) {
        const cell = row.cells.get(col);
        if (cell !== undefined) visit(cell, row.index, col);
      }
    } else {
      // Collected first: `visit` may remove cells from the row.
      const hits: number[] = [];
      for (const col of row.cells.keys()) if (col >= start.col && col <= end.col) hits.push(col);
      for (const col of hits) {
        const cell = row.cells.get(col);
        if (cell !== undefined) visit(cell, row.index, col);
      }
    }
  };
  if (end.row - start.row + 1 <= sheet.rows.size) {
    for (let index = start.row; index <= end.row; index++) {
      const row = sheet.rows.get(index);
      if (row !== undefined) visitRow(row);
    }
  } else {
    const rows: RowRec[] = [];
    for (const row of sheet.rows.values()) if (row.index >= start.row && row.index <= end.row) rows.push(row);
    for (const row of rows) visitRow(row);
  }
}

export function clearRange(state: WorkbookState, sheet: SheetModel, range: CellRange, what: "contents" | "formats" | "all"): void {
  forEachCellIn(sheet, range, (cell, row, col) => {
    const next: RawCell =
      what === "contents"
        ? { value: null, formula: null, styleId: cell.styleId }
        : what === "formats"
          ? { value: cell.value, formula: cell.formula, styleId: 0 }
          : { value: null, formula: null, styleId: 0 };
    writeCell(state, sheet, row, col, next, "edit", what === "formats");
  });
}

export function setStyle(state: WorkbookState, sheet: SheetModel, range: CellRange, patch: CellStylePatch): void {
  requireSmallRange(range);
  // Checks the patch before the first cell is touched.
  applyStylePatch(state.styles, 0, patch);
  for (let row = range.start.row; row <= range.end.row; row++) {
    for (let col = range.start.col; col <= range.end.col; col++) {
      const cell = findCell(sheet, row, col);
      const styleId = applyStylePatch(state.styles, cell?.styleId ?? 0, patch);
      writeCell(
        state,
        sheet,
        row,
        col,
        { value: cell?.value ?? null, formula: cell?.formula ?? null, styleId },
        "edit",
        true,
      );
    }
  }
}
