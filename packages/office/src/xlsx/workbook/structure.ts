/**
 * Inserting and deleting rows and columns: cells, sizes, merged ranges, the
 * ranges other sheet features point at, the ranges of tables and the notes
 * on cells move with them, and every formula and defined name of the
 * workbook that refers to the sheet is rewritten. An edit that would cut a
 * table apart is refused.
 */

import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { getAttr, remove, setAttr, setTextContent, textContent } from "../../xml/index.js";
import { MAX_COLS, MAX_ROWS, formatA1Range, tryParseA1Range } from "./a1.js";
import { checkNotesForStructure, moveNotes } from "./notes.js";
import { type CellRec, type ColumnRun, DIRTY_CONTENT, type RowRec, type SheetModel, type WorkbookState } from "./model.js";
import { type StructuralOp, movePoint, moveSpan, rewriteForStructure } from "./refs-rewrite.js";
import { rewriteAllFormulas } from "./sheets.js";
import { attachSheet } from "./sheet-read.js";
import { sheetDimensions } from "./sheet-write.js";
import { invalidateArrayRanges } from "./arrays.js";
import { forEachExtensionElement } from "./feature-formulas.js";
import { dropCalcChain, invalidateGraph } from "./state.js";
import { checkTablesForStructure, moveTables } from "./tables.js";
import { kid, kids } from "./xml-util.js";

function checkOp(op: StructuralOp): void {
  const limit = op.axis === "row" ? MAX_ROWS : MAX_COLS;
  const count = Math.abs(op.count);
  if (!Number.isInteger(op.index) || !Number.isInteger(op.count) || op.index < 0 || count < 1 || op.index + count > limit) {
    throw new OfficeError("invalid_argument", "index and count must name rows or columns of the sheet");
  }
}

/** Moves a range; null when nothing of it is left. */
function moveRange<T extends { start: { row: number; col: number }; end: { row: number; col: number } }>(range: T, op: StructuralOp): T | null {
  if (op.axis === "row") {
    const span = moveSpan(range.start.row, range.end.row, op);
    if (span === null) return null;
    return { ...range, start: { row: span.low, col: range.start.col }, end: { row: span.high, col: range.end.col } };
  }
  const span = moveSpan(range.start.col, range.end.col, op);
  if (span === null) return null;
  return { ...range, start: { row: range.start.row, col: span.low }, end: { row: range.end.row, col: span.high } };
}

function countCells(cells: Iterable<CellRec>): number {
  let count = 0;
  for (const cell of cells) if (cell.value !== null || cell.formula !== null) count++;
  return count;
}

function moveArrayRef(cell: CellRec, row: RowRec, op: StructuralOp): void {
  const extra = cell.extra;
  if (extra === null || extra.ref === null) return;
  const moved = moveRange(extra.ref, op);
  cell.extra = { attrs: extra.attrs, ref: moved };
  cell.dirty |= DIRTY_CONTENT;
  row.dirty = true;
}

function moveCells(state: WorkbookState, sheet: SheetModel, op: StructuralOp): void {
  if (op.axis === "row") {
    const rows = new Map<number, RowRec>();
    for (const row of sheet.rows.values()) {
      const target = movePoint(row.index, op);
      if (target < 0) {
        state.cellCount -= countCells(row.cells.values());
        continue;
      }
      if (target !== row.index) {
        row.index = target;
        row.dirty = true;
      }
      for (const cell of row.cells.values()) moveArrayRef(cell, row, op);
      rows.set(target, row);
    }
    sheet.rows = rows;
    sheet.rowSetDirty = true;
    sheet.rowsUnordered = true;
    return;
  }
  for (const row of sheet.rows.values()) {
    let changed = false;
    const cells = new Map<number, CellRec>();
    for (const [col, cell] of row.cells) {
      const target = movePoint(col, op);
      if (target !== col) changed = true;
      if (target < 0) {
        if (cell.value !== null || cell.formula !== null) state.cellCount--;
        continue;
      }
      moveArrayRef(cell, row, op);
      cells.set(target, cell);
    }
    if (changed) {
      row.cells = cells;
      row.dirty = true;
    }
  }
}

function moveColumns(sheet: SheetModel, op: StructuralOp): void {
  if (op.axis !== "col" || sheet.columns.length === 0) return;
  const runs: ColumnRun[] = [];
  for (const run of sheet.columns) {
    const span = moveSpan(run.min, run.max, op);
    if (span !== null) runs.push({ ...run, min: span.low, max: span.high });
  }
  sheet.columns = runs;
  sheet.columnsDirty = true;
}

/** Moves a space-separated list of ranges (`sqref`). Returns null when none is left. */
function moveRangeList(text: string, op: StructuralOp): string | null {
  const kept: string[] = [];
  for (const part of text.split(/\s+/)) {
    if (part === "") continue;
    const range = tryParseA1Range(part);
    if (range === null) {
      kept.push(part);
      continue;
    }
    const moved = moveRange(range, op);
    if (moved !== null) kept.push(formatA1Range(moved));
  }
  return kept.length === 0 ? null : kept.join(" ");
}

/**
 * Updates the ranges of conditional formats, data validations, hyperlinks
 * and the auto filter, also the validations and formats kept in the
 * extension list. A feature whose range is gone goes with it. The formulas
 * of the features are rewritten with every other formula of the workbook.
 */
function moveSheetFeatures(sheet: SheetModel, op: StructuralOp): void {
  const root = attachSheet(sheet).doc.root;
  const adjust = (element: XmlElement, attr: string): boolean => {
    const value = getAttr(element, attr);
    if (value === null) return true;
    const moved = moveRangeList(value, op);
    if (moved === null) return false;
    if (moved !== value) setAttr(element, attr, moved);
    return true;
  };
  for (const format of kids(root, "conditionalFormatting")) if (!adjust(format, "sqref")) remove(format);
  for (const [container, item, attr] of [
    ["dataValidations", "dataValidation", "sqref"],
    ["hyperlinks", "hyperlink", "ref"],
  ] as const) {
    const list = kid(root, container);
    if (list === null) continue;
    for (const entry of kids(list, item)) if (!adjust(entry, attr)) remove(entry);
    const left = kids(list, item).length;
    if (left === 0) remove(list);
    else if (getAttr(list, "count") !== null) setAttr(list, "count", String(left));
  }
  const filter = kid(root, "autoFilter");
  if (filter !== null && !adjust(filter, "ref")) remove(filter);
  const extensions = kid(root, "extLst");
  if (extensions === null) return;
  forEachExtensionElement(extensions, "sqref", (ranges) => {
    const text = textContent(ranges);
    const moved = moveRangeList(text, op);
    if (moved === null) {
      // The validation or format that owns the ranges has no cell left.
      const owner = ranges.parent;
      if (owner !== null && owner.kind === "element") {
        const list = owner.parent;
        remove(owner);
        if (list !== null && list.kind === "element" && getAttr(list, "count") !== null) {
          setAttr(list, "count", String(list.children.filter((node) => node.kind === "element").length));
        }
      }
    } else if (moved !== text) {
      setTextContent(ranges, moved);
    }
  });
}

/** Inserts or deletes rows or columns of a sheet. */
export function applyStructuralOp(state: WorkbookState, sheet: SheetModel, op: StructuralOp): void {
  checkOp(op);
  if (state.journal !== null && state.journal.pendingChangeCount(sheet.id) > 0) {
    throw new OfficeError("invalid_operation", "the sheet has pending changes");
  }
  if (op.count > 0) {
    const used = sheetDimensions(sheet);
    const last = used === null ? -1 : op.axis === "row" ? used.end.row : used.end.col;
    if (last >= op.index && last + op.count >= (op.axis === "row" ? MAX_ROWS : MAX_COLS)) {
      throw new OfficeError("invalid_operation", "the insertion would push cells off the sheet");
    }
  }
  // A table cannot be cut apart; this throws before anything moves.
  checkTablesForStructure(sheet, op);
  checkNotesForStructure(sheet);
  moveCells(state, sheet, op);
  // Array formulas moved with their cells, or went with deleted ones.
  invalidateArrayRanges(sheet);
  const merges = [];
  for (const merge of sheet.merges) {
    const moved = moveRange(merge, op);
    if (moved !== null) merges.push(moved);
  }
  sheet.merges = merges;
  sheet.mergesDirty = true;
  moveColumns(sheet, op);
  moveSheetFeatures(sheet, op);
  moveTables(sheet, op);
  moveNotes(sheet, op);
  // Shared formulas are written out one by one: their group ranges no longer hold.
  if (sheet.hasShared) sheet.unshare = true;
  sheet.dirty = true;
  sheet.dimensions = undefined;
  const key = sheet.name.toLowerCase();
  rewriteAllFormulas(state, (text, owner) => rewriteForStructure(text, owner === sheet, key, op), null);
  state.calc.edited.delete(sheet);
  state.calc.all = true;
  invalidateGraph(state);
  dropCalcChain(state);
}
