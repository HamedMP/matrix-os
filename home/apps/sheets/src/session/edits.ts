/**
 * The edits a session offers, written against a {@link Transaction}.
 *
 * Cell edits go through the workbook's own methods, so the change journal
 * sees them (an edit to a cell with a pending proposed change accepts that
 * change first) and the recorder notes them for undo.
 */

import {
  type CellAddress,
  type CellRange,
  type CellStyle,
  type CellStylePatch,
  type CellValue,
  type FrozenPanes,
  MAX_COLS,
  MAX_ROWS,
  type SheetId,
  type Workbook,
  isOfficeError,
} from "./engine";
import { SheetSessionError } from "./file-io";

/** What an edit may do inside a session transaction. */
export interface Transaction {
  /** Use any cell method: `setCell`, `setRange`, `setFormula`, `setCellInput`, `clearRange`, `setStyle`. */
  readonly workbook: Workbook;
  /**
   * Claims room for `cells` changed cells before writing them, so that a step
   * never changes more than it can take back. Throws `too_many_cells` when the
   * step, with what it already claimed, would pass {@link MAX_TRANSACTION_CELLS}.
   */
  reserve(cells: number): void;
  insertRows(sheet: SheetId, index: number, count: number): void;
  deleteRows(sheet: SheetId, index: number, count: number): void;
  insertColumns(sheet: SheetId, index: number, count: number): void;
  deleteColumns(sheet: SheetId, index: number, count: number): void;
  /** Width in characters; null restores the default. */
  setColumnWidths(sheet: SheetId, cols: readonly number[], width: number | null): void;
  /** Height in points; null restores the default. */
  setRowHeights(sheet: SheetId, rows: readonly number[], heightPt: number | null): void;
  mergeCells(sheet: SheetId, range: CellRange): void;
  unmergeCells(sheet: SheetId, range: CellRange): void;
  setFrozenPanes(sheet: SheetId, frozen: FrozenPanes): void;
  renameSheet(sheet: SheetId, name: string): void;
}

/**
 * One cell edit. Give `input` (text as typed: `=A1+1`, `12%`, `2026-01-31`),
 * or `value` (a literal), or `formula` (text without `=`; null keeps the
 * value and drops the formula). `style` is applied after the content.
 */
export interface SessionCellEdit {
  sheet: SheetId;
  row: number;
  col: number;
  input?: string;
  value?: CellValue;
  formula?: string | null;
  style?: CellStylePatch;
}

/** Most cells one transaction may change: what its undo record keeps, and so what a failed step can put back. */
export const MAX_TRANSACTION_CELLS = 500_000;

/** Most cells one style or clear call touches before a whole-row or whole-column range is cut to the used area. */
export const LARGE_RANGE_CELLS = 100_000;
const MIN_STYLED_ROWS = 1000;
const MIN_STYLED_COLS = 26;

export function rangeArea(range: CellRange): number {
  return (range.end.row - range.start.row + 1) * (range.end.col - range.start.col + 1);
}

/**
 * Cuts a very large range (a whole row, column or sheet) down to the used
 * area of the sheet plus a margin, so that formatting a column does not
 * create a million cells. Throws `too_many_cells` when it is still too large.
 */
export function clampRange(workbook: Workbook, sheet: SheetId, range: CellRange): CellRange {
  if (rangeArea(range) <= LARGE_RANGE_CELLS) return range;
  const used = workbook.getSheet(sheet).dimensions;
  const lastRow = Math.max(used?.end.row ?? 0, range.start.row + MIN_STYLED_ROWS - 1);
  const lastCol = Math.max(used?.end.col ?? 0, range.start.col + MIN_STYLED_COLS - 1);
  const cut: CellRange = {
    start: range.start,
    end: { row: Math.min(range.end.row, lastRow), col: Math.min(range.end.col, lastCol) },
  };
  if (rangeArea(cut) > MAX_TRANSACTION_CELLS) throw new SheetSessionError("too_many_cells");
  return cut;
}

export function applyCellEdit(workbook: Workbook, edit: SessionCellEdit): void {
  const address: CellAddress = { row: edit.row, col: edit.col };
  if (edit.input !== undefined) workbook.setCellInput(edit.sheet, address, edit.input);
  else if (edit.formula !== undefined && edit.formula !== null) workbook.setFormula(edit.sheet, address, edit.formula);
  else if (edit.value !== undefined) workbook.setCell(edit.sheet, address, edit.value);
  else if (edit.formula === null) workbook.setFormula(edit.sheet, address, null);
  if (edit.style !== undefined) workbook.setStyle(edit.sheet, { start: address, end: address }, edit.style);
}

/** The cells `applyInputs` writes from `start`: the fields that fall inside the sheet. */
export function inputCellCount(start: CellAddress, rows: ReadonlyArray<ReadonlyArray<string>>): number {
  const width = Math.max(0, MAX_COLS - start.col);
  let count = 0;
  for (let r = 0; r < rows.length && start.row + r < MAX_ROWS; r++) count += Math.min((rows[r] as ReadonlyArray<string>).length, width);
  return count;
}

/** Writes rows of typed text from `start`, as a paste of plain text does. Cells past the sheet edge are dropped. */
export function applyInputs(workbook: Workbook, sheet: SheetId, start: CellAddress, rows: ReadonlyArray<ReadonlyArray<string>>): void {
  for (let r = 0; r < rows.length; r++) {
    const row = start.row + r;
    if (row >= MAX_ROWS) break;
    const fields = rows[r] as ReadonlyArray<string>;
    for (let c = 0; c < fields.length; c++) {
      const col = start.col + c;
      if (col >= MAX_COLS) break;
      const text = fields[c] as string;
      try {
        workbook.setCellInput(sheet, { row, col }, text);
      } catch (error: unknown) {
        // Pasted text that starts with `=` but is not a formula stays as the text it is.
        if (!isOfficeError(error, "formula_error")) throw error;
        workbook.setCell(sheet, { row, col }, text);
      }
    }
  }
}

/** The first free "SheetN" name, counting on from the number of sheets. */
export function nextSheetName(workbook: Pick<Workbook, "listSheets">): string {
  const taken = new Set(workbook.listSheets().map((sheet) => sheet.name.toLowerCase()));
  for (let n = taken.size + 1; ; n++) if (!taken.has(`sheet${n}`)) return `Sheet${n}`;
}

/** A complete style as a patch, to copy the look of one cell to another. */
export function styleAsPatch(style: CellStyle): CellStylePatch {
  return {
    font: { ...style.font },
    fill: { ...style.fill },
    border: {
      top: { ...style.border.top },
      right: { ...style.border.right },
      bottom: { ...style.border.bottom },
      left: { ...style.border.left },
    },
    alignment: { ...style.alignment },
    numberFormat: style.numberFormat,
  };
}
