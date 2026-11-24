/**
 * What to draw: turns the layout of the active sheet into plain lists of
 * rows and cells with pixel positions, text and classes. Only cells on screen
 * that hold something (content, a format, a decoration, the active cell) are
 * listed, so the cost follows the window, not the sheet.
 */

import type { Cell, CellRange, CellValue, SheetId } from "../session/engine";
import { columnLabel } from "../session/engine";
import { CELL_PADDING_PX, type CellLook, cellLook, errorHelp, overflowWidth, textWidth } from "./cell-look";
import type { GridContext, GridLayout } from "./context";
import { type CellDecoration, describeDecoration } from "./decorations";
import { type Selection, rangesIntersect, selectionContains } from "./selection";
import type { Span } from "./viewport";

export type PaneId = "corner" | "top" | "left" | "main";

/** One of the up to four parts the frozen panes split the cell area into. */
export interface PaneSpec {
  id: PaneId;
  rows: Span;
  cols: Span;
  /** Position and size of the pane inside the cell area. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Sheet pixel shown at the pane's left and top edge. */
  offsetX: number;
  offsetY: number;
}

export interface CellItem {
  id: string;
  row: number;
  col: number;
  /** Position inside the row element. */
  left: number;
  width: number;
  height: number;
  text: string;
  css: Record<string, string | number>;
  className: string;
  title: string | undefined;
  selected: boolean;
  /** Words added to the cell for screen readers (decorations, errors), or undefined. */
  description: string | undefined;
  changeId: string | undefined;
}

export interface RowItem {
  row: number;
  top: number;
  height: number;
  cells: CellItem[];
}

export interface PaneModel {
  rows: RowItem[];
  /** Positions of the grid lines inside the pane. */
  horizontal: number[];
  vertical: number[];
}

function nonEmpty(span: Span): boolean {
  return span.end >= span.start;
}

/** The panes to draw for a layout. Empty parts are left out. */
export function paneSpecs(layout: GridLayout): PaneSpec[] {
  const { viewport, viewportInput } = layout;
  const { frozenWidth, frozenHeight } = viewport;
  const mainWidth = Math.max(0, viewportInput.width - frozenWidth);
  const mainHeight = Math.max(0, viewportInput.height - frozenHeight);
  const scrollX = frozenWidth + viewport.scrollLeft;
  const scrollY = frozenHeight + viewport.scrollTop;
  const panes: PaneSpec[] = [];
  if (nonEmpty(viewport.rows) && nonEmpty(viewport.cols)) {
    panes.push({ id: "main", rows: viewport.rows, cols: viewport.cols, x: frozenWidth, y: frozenHeight, width: mainWidth, height: mainHeight, offsetX: scrollX, offsetY: scrollY });
  }
  if (nonEmpty(viewport.frozenRows) && nonEmpty(viewport.cols)) {
    panes.push({ id: "top", rows: viewport.frozenRows, cols: viewport.cols, x: frozenWidth, y: 0, width: mainWidth, height: frozenHeight, offsetX: scrollX, offsetY: 0 });
  }
  if (nonEmpty(viewport.rows) && nonEmpty(viewport.frozenCols)) {
    panes.push({ id: "left", rows: viewport.rows, cols: viewport.frozenCols, x: 0, y: frozenHeight, width: frozenWidth, height: mainHeight, offsetX: 0, offsetY: scrollY });
  }
  if (nonEmpty(viewport.frozenRows) && nonEmpty(viewport.frozenCols)) {
    panes.push({ id: "corner", rows: viewport.frozenRows, cols: viewport.frozenCols, x: 0, y: 0, width: frozenWidth, height: frozenHeight, offsetX: 0, offsetY: 0 });
  }
  return panes;
}

export function cellElementId(gridId: string, row: number, col: number): string {
  return `${gridId}-r${row}c${col}`;
}

/** True when a cell is in the rendered window, so that an element with its id exists. */
export function activeOnScreen(layout: GridLayout, cell: { row: number; col: number }): boolean {
  const { viewport } = layout;
  const inRows = cell.row <= viewport.frozenRows.end || (cell.row >= viewport.rows.start && cell.row <= viewport.rows.end);
  const inCols = cell.col <= viewport.frozenCols.end || (cell.col >= viewport.cols.start && cell.col <= viewport.cols.end);
  return inRows && inCols;
}

/** Id of an entry of the function list. */
export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

const looks = new WeakMap<object, Map<string, CellLook>>();
const MAX_LOOKS = 8192;

function valueKind(value: CellValue): string {
  if (value === null) return "0";
  if (typeof value === "number") return "n";
  if (typeof value === "string") return "s";
  if (typeof value === "boolean") return "b";
  return "e";
}

function lookOf(ctx: GridContext, cell: Cell): CellLook {
  const workbook = ctx.session.workbook;
  let cache = looks.get(workbook);
  if (cache === undefined) {
    cache = new Map();
    looks.set(workbook, cache);
  }
  const key = `${cell.styleId}|${valueKind(cell.value)}`;
  let look = cache.get(key);
  if (look === undefined) {
    if (cache.size >= MAX_LOOKS) cache.clear();
    look = cellLook(workbook.getStyle(cell.styleId), cell.value);
    cache.set(key, look);
  }
  return look;
}

/**
 * The text a number shows in a column: its display text when that fits, a
 * shorter form of a plainly formatted number when not, and `####` when even
 * that does not fit, so that a cut-off number is never read as another one.
 */
export function fitNumberText(value: number, display: string, general: boolean, fits: (text: string) => boolean): string {
  if (fits(display)) return display;
  if (general) {
    for (let digits = 10; digits >= 1; digits--) {
      const shorter = String(Number(value.toPrecision(digits)));
      if (shorter.length < display.length && fits(shorter)) return shorter;
    }
  }
  return "####";
}

const DECORATION_CLASS: Record<CellDecoration["kind"], string> = {
  proposed: "is-proposed",
  precedent: "is-precedent",
  dependent: "is-dependent",
  search: "is-search",
  "search-active": "is-search-active",
};

export interface BuildOptions {
  gridId: string;
  selection: Selection;
  /** The cell whose text is hidden because the editor covers it. */
  editing: { sheet: SheetId; row: number; col: number } | null;
}

/** Columns looked at to the left of the window for text that runs into it. */
const OVERFLOW_LOOKBEHIND = 24;

export function buildPane(ctx: GridContext, layout: GridLayout, pane: PaneSpec, options: BuildOptions): PaneModel {
  const { axes, info, sheet } = layout;
  const { rows, cols } = axes;
  const session = ctx.session;
  const workbook = session.workbook;
  const selection = options.selection;
  const active = selection.active;
  const byRow = new Map<number, RowItem>();
  const window: CellRange = { start: { row: pane.rows.start, col: pane.cols.start }, end: { row: pane.rows.end, col: pane.cols.end } };
  const merges = info.mergedRanges.filter((merge) => rangesIntersect(merge, window));
  const covered = new Set<number>();
  const coverKey = (row: number, col: number): number => (row - window.start.row) * (window.end.col - window.start.col + 1) + (col - window.start.col);
  for (const merge of merges) {
    for (let row = Math.max(merge.start.row, window.start.row); row <= Math.min(merge.end.row, window.end.row); row++) {
      for (let col = Math.max(merge.start.col, window.start.col); col <= Math.min(merge.end.col, window.end.col); col++) covered.add(coverKey(row, col));
    }
  }
  const isCovered = (row: number, col: number): boolean =>
    row >= window.start.row && row <= window.end.row && col >= window.start.col && col <= window.end.col && covered.has(coverKey(row, col));

  const rowItem = (row: number): RowItem => {
    let item = byRow.get(row);
    if (item === undefined) {
      item = { row, top: rows.offsetOf(row) - pane.offsetY, height: rows.sizeOf(row), cells: [] };
      byRow.set(row, item);
    }
    return item;
  };

  const blankAt = (row: number, col: number): boolean => col < cols.count && session.isBlank(sheet, row, col) && !isCovered(row, col);

  /** Adds a cell when there is something to draw. `merge` gives the size of a merged cell. */
  const add = (row: number, col: number, merge: CellRange | null, force = false): void => {
    const cell = ctx.cell(sheet, row, col);
    const decorations = ctx.decorations.at(sheet, row, col);
    const isActive = active.row === row && active.col === col;
    const pending = cell.pendingChangeId !== null;
    if (!force && cell.value === null && cell.styleId === 0 && !pending && decorations.length === 0 && !isActive && merge === null) return;
    const look = lookOf(ctx, cell);
    const own = merge === null ? cols.sizeOf(col) : cols.offsetOf(Math.min(merge.end.col, cols.count - 1) + 1) - cols.offsetOf(col);
    const height = merge === null ? rows.sizeOf(row) : rows.offsetOf(Math.min(merge.end.row, rows.count - 1) + 1) - rows.offsetOf(row);
    let width = own;
    let text = cell.display;
    let className = "sg-cell";
    const room = own - CELL_PADDING_PX;
    if (typeof cell.value === "number") {
      const general = workbook.getStyle(cell.styleId).numberFormat === "General";
      text = fitNumberText(cell.value, text, general, (candidate) => textWidth(candidate, look) <= room);
    } else if (typeof cell.value === "string" && merge === null && look.align === "left" && !look.wrap && text !== "") {
      const needed = textWidth(text, look) + CELL_PADDING_PX;
      if (needed > own) {
        const extra = overflowWidth(needed, own, (index) => (blankAt(row, col + index) ? cols.sizeOf(col + index) : null));
        if (extra > 0) {
          width = own + extra;
          className += " is-overflow";
        }
      }
    }
    if (merge !== null) className += " is-merged";
    const help = errorHelp(cell.value);
    if (help !== null) className += " is-error";
    if (pending) className += " is-pending";
    const notes: string[] = [];
    let changeId: string | undefined = cell.pendingChangeId ?? undefined;
    for (const decoration of decorations) {
      className += ` ${DECORATION_CLASS[decoration.kind]}`;
      notes.push(describeDecoration(decoration));
      if (decoration.changeId !== undefined) changeId = decoration.changeId;
    }
    if (pending && !decorations.some((decoration) => decoration.kind === "proposed")) notes.push("Proposed change");
    if (help !== null) notes.push(help);
    if (cell.formulaUnsupported) notes.push("This formula is not calculated here; the saved value is shown.");
    const editing = options.editing !== null && options.editing.sheet === sheet && options.editing.row === row && options.editing.col === col;
    const description = notes.length === 0 ? undefined : notes.join(" ");
    rowItem(row).cells.push({
      id: cellElementId(options.gridId, row, col),
      row,
      col,
      left: cols.offsetOf(col) - pane.offsetX,
      width,
      height,
      text: editing ? "" : text,
      css: look.css,
      className,
      title: description,
      selected: selectionContains(selection, row, col),
      description,
      changeId,
    });
  };

  for (const merge of merges) add(merge.start.row, merge.start.col, merge);

  const firstCol = pane.cols.start;
  const lookBehindLimit = pane.id === "main" || pane.id === "top" ? Math.max(layout.viewport.frozenCols.end + 1, firstCol - OVERFLOW_LOOKBEHIND) : firstCol;
  const horizontal: number[] = [];
  const used = info.dimensions;
  for (let row = pane.rows.start; row <= pane.rows.end; row++) {
    const size = rows.sizeOf(row);
    if (size === 0) continue;
    horizontal.push(rows.offsetOf(row) - pane.offsetY + size - 1);
    const inUsedRows = used !== null && row >= used.start.row && row <= used.end.row;
    // Text that starts left of the window and runs into it.
    if (inUsedRows && lookBehindLimit < firstCol && blankAt(row, firstCol)) {
      for (let col = firstCol - 1; col >= lookBehindLimit; col--) {
        if (session.isBlank(sheet, row, col)) continue;
        if (!info.mergedRanges.some((merge) => row >= merge.start.row && row <= merge.end.row && col >= merge.start.col && col <= merge.end.col)) add(row, col, null);
        break;
      }
    }
    for (let col = pane.cols.start; col <= pane.cols.end; col++) {
      if (cols.sizeOf(col) === 0 || isCovered(row, col)) continue;
      add(row, col, null);
    }
  }
  const vertical: number[] = [];
  for (let col = pane.cols.start; col <= pane.cols.end; col++) {
    const size = cols.sizeOf(col);
    if (size > 0) vertical.push(cols.offsetOf(col) - pane.offsetX + size - 1);
  }
  const ordered = [...byRow.values()].filter((item) => item.cells.length > 0).sort((a, b) => a.row - b.row);
  for (const item of ordered) item.cells.sort((a, b) => a.col - b.col);
  return { rows: ordered, horizontal, vertical };
}

/** What a screen reader hears for the active cell: its address, what it shows, its formula and its marks. */
export function describeActiveCell(ctx: GridContext): string {
  const sheet = ctx.sheet;
  const selection = ctx.selection;
  const { row, col } = selection.active;
  const cell = ctx.cell(sheet, row, col);
  const parts = [`${columnLabel(col)}${row + 1}`, cell.display === "" ? "empty" : cell.display];
  if (cell.formula !== null) parts.push(`formula =${cell.formula}`);
  const help = errorHelp(cell.value);
  if (help !== null) parts.push(help);
  for (const decoration of ctx.decorations.at(sheet, row, col)) parts.push(describeDecoration(decoration));
  if (cell.pendingChangeId !== null && ctx.decorations.at(sheet, row, col).every((entry) => entry.kind !== "proposed")) parts.push("Proposed change");
  const range = selection.ranges[selection.ranges.length - 1];
  if (range !== undefined && (range.start.row !== range.end.row || range.start.col !== range.end.col)) {
    if (range.kind === "rows") parts.push(`${range.end.row - range.start.row + 1} rows selected`);
    else if (range.kind === "cols") parts.push(`${range.end.col - range.start.col + 1} columns selected`);
    else if (range.kind === "all") parts.push("whole sheet selected");
    else parts.push(`${range.end.row - range.start.row + 1} by ${range.end.col - range.start.col + 1} cells selected`);
  }
  if (selection.ranges.length > 1) parts.push(`${selection.ranges.length} ranges`);
  return parts.join(", ");
}
