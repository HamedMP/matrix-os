/**
 * What every grid action works with: the session, the grid store, and the
 * layout of the active sheet (its axes and what is on screen), computed once
 * per change and shared by the actions and the components.
 */

import type { Cell, CellAddress, CellRange, SheetId, SheetInfo } from "../session/engine";
import type { SheetSession } from "../session/session";
import { DecorationStore } from "./decorations";
import { type FunctionCatalog, createFunctionCatalog } from "./function-hints";
import { type GridExtent, type SheetAxes, gridExtent, sheetAxes } from "./geometry";
import type { NavContext } from "./navigation";
import { type Selection, activeRange } from "./selection";
import { GridStore, type SheetView } from "./store";
import { type Viewport, type ViewportInput, computeViewport, scrollToReveal } from "./viewport";

export interface GridLayout {
  sheet: SheetId;
  info: SheetInfo;
  extent: GridExtent;
  axes: SheetAxes;
  hiddenRows: ReadonlySet<number> | null;
  viewportInput: ViewportInput;
  viewport: Viewport;
}

/** Most cell views kept between two changes of the workbook. */
const MAX_CACHED_CELLS = 20_000;

export class GridContext {
  readonly store = new GridStore();
  readonly decorations = new DecorationStore();
  private catalogValue: FunctionCatalog | null = null;
  private layoutKey = "";
  private layoutValue: GridLayout | null = null;
  private infoRevision = -1;
  private infoSheet: SheetId | null = null;
  private infoValue: SheetInfo | null = null;
  private hiddenSource: readonly number[] | null = null;
  private hiddenSet: ReadonlySet<number> | null = null;
  private cellRevision = -1;
  private readonly cells = new Map<string, Cell>();

  constructor(readonly session: SheetSession) {}

  /** The engine's functions with their hints; built on first use. */
  get catalog(): FunctionCatalog {
    this.catalogValue ??= createFunctionCatalog();
    return this.catalogValue;
  }

  get sheet(): SheetId {
    return this.session.getState().activeSheetId;
  }

  get view(): SheetView {
    return this.store.view(this.sheet);
  }

  get selection(): Selection {
    return this.view.selection;
  }

  /** Sheet facts (sizes, merges, frozen panes), read once per workbook change. */
  info(): SheetInfo {
    const revision = this.session.getState().revision;
    const sheet = this.sheet;
    if (this.infoValue === null || this.infoRevision !== revision || this.infoSheet !== sheet) {
      this.infoValue = this.session.sheet(sheet);
      this.infoRevision = revision;
      this.infoSheet = sheet;
    }
    return this.infoValue;
  }

  /** A cell with its display text, cached until the workbook changes. */
  cell(sheet: SheetId, row: number, col: number): Cell {
    const revision = this.session.getState().revision;
    if (this.cellRevision !== revision) {
      this.cells.clear();
      this.cellRevision = revision;
    }
    const key = `${sheet}|${row}|${col}`;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      if (this.cells.size >= MAX_CACHED_CELLS) this.cells.clear();
      cell = this.session.cell(sheet, row, col);
      this.cells.set(key, cell);
    }
    return cell;
  }

  private hidden(view: SheetView): ReadonlySet<number> | null {
    const source = view.filter?.hidden ?? null;
    if (source !== this.hiddenSource) {
      this.hiddenSource = source;
      this.hiddenSet = source === null || source.length === 0 ? null : new Set(source);
    }
    return this.hiddenSet;
  }

  /** Axes and viewport of the active sheet for the current state. */
  layout(): GridLayout {
    const state = this.store.getState();
    const sheet = this.sheet;
    const view = this.store.view(sheet);
    const info = this.info();
    const selection = view.selection;
    const range = activeRange(selection);
    // Whole-row and whole-column ranges reach the end of the sheet; they do not stretch the grid.
    const focus: CellAddress[] = [selection.active];
    if (range.kind === "cells") focus.push(selection.focus, range.end);
    const edit = state.edit;
    if (edit !== null && edit.pointing !== null && edit.pointing.sheet === sheet) focus.push(edit.pointing.focus);
    const extent = gridExtent(info.dimensions, focus);
    const hiddenRows = this.hidden(view);
    const resizing = state.resizing;
    const key = [
      this.session.getState().revision,
      sheet,
      extent.rows,
      extent.cols,
      view.filter === null ? 0 : view.filter.hidden.length,
      view.scrollTop,
      view.scrollLeft,
      state.width,
      state.height,
      resizing === null ? "" : `${resizing.axis}${resizing.index}:${resizing.size}`,
    ].join("|");
    if (this.layoutValue !== null && key === this.layoutKey && this.layoutValue.hiddenRows === hiddenRows) return this.layoutValue;
    const axes = sheetAxes(info, extent, hiddenRows, resizing);
    const viewportInput: ViewportInput = {
      axes,
      frozenRows: info.frozen.rows,
      frozenCols: info.frozen.cols,
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      width: state.width,
      height: state.height,
    };
    this.layoutKey = key;
    this.layoutValue = { sheet, info, extent, axes, hiddenRows, viewportInput, viewport: computeViewport(viewportInput) };
    return this.layoutValue;
  }

  /** What keyboard navigation needs to know about the active sheet. */
  navContext(): NavContext {
    const layout = this.layout();
    const sheet = layout.sheet;
    const { rows, cols } = layout.axes;
    return {
      merges: layout.info.mergedRanges,
      used: layout.info.dimensions,
      isBlank: (row, col) => this.session.isBlank(sheet, row, col),
      isRowHidden: (row) => row < rows.count && rows.sizeOf(row) === 0,
      isColHidden: (col) => col < cols.count && cols.sizeOf(col) === 0,
    };
  }

  /** Replaces the selection and scrolls its moving end into view. */
  select(selection: Selection, reveal: CellAddress | null = selection.focus): void {
    const sheet = this.sheet;
    this.store.setView(sheet, { selection });
    if (reveal !== null) this.reveal(reveal);
  }

  /** Scrolls the active sheet so that a cell is visible. */
  reveal(cell: CellAddress): void {
    // The layout is read after the selection changed, so the grid already reaches the cell.
    const layout = this.layout();
    const next = scrollToReveal(layout.viewportInput, cell);
    this.store.setView(layout.sheet, next);
  }

  notice(message: string | null): void {
    this.store.set({ notice: message });
  }

  /** The used part of the ranges, or the active cell when nothing of them is used. */
  usedRanges(ranges: readonly CellRange[]): CellRange[] {
    const used = this.info().dimensions;
    const out: CellRange[] = [];
    for (const range of ranges) {
      if (used === null) continue;
      const startRow = Math.max(range.start.row, used.start.row);
      const endRow = Math.min(range.end.row, used.end.row);
      const startCol = Math.max(range.start.col, used.start.col);
      const endCol = Math.min(range.end.col, used.end.col);
      if (startRow <= endRow && startCol <= endCol) out.push({ start: { row: startRow, col: startCol }, end: { row: endRow, col: endCol } });
    }
    return out;
  }
}
