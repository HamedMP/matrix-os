/**
 * The imperative side of the grid: what toolbars, the review panel and the
 * agent call. See `./index.ts` for the overview.
 */

import type { CellAddress, CellRange, CellStylePatch, SheetId } from "../session/engine";
import type { SessionCellEdit } from "../session/edits";
import type { SheetSession } from "../session/session";
import type { EditResult, SessionEvent } from "../session/types";
import { type ClipboardPayload, clearCopyMark, copySelection, isPasting, pasteClipboard } from "./actions-clipboard";
import { type ClickCopyOutcome, type ClickPasteOutcome, clickCopy, clickPaste } from "./click-clipboard";
import {
  applyFilter,
  clearSelection,
  deleteColumns,
  deleteRows,
  fillSelection,
  filterByActiveValue,
  insertColumns,
  insertRows,
  refreshFilter,
  report,
  sortRange,
  sortSelection,
  styleSelection,
  toggleFormat,
} from "./actions-data";
import { afterEditCommitted, cancelEdit, commitEdit, startEdit } from "./actions-edit";
import { goToRange } from "./actions-move";
import { GridContext } from "./context";
import type { CellDecoration } from "./decorations";
import { type SelRange, activeRange } from "./selection";
import type { FilterSpec, SortKey } from "./sort-filter";

export interface GridSelection {
  sheet: SheetId;
  /** The cell that receives typing. */
  active: CellAddress;
  /** Every selected range; the last is the one being worked on. `kind` tells whole rows, columns or the sheet. */
  ranges: SelRange[];
}

const MAX_SELECTION_LISTENERS = 32;

export class SheetGridController {
  /** State shared with the `SheetGrid` component. Not for other callers. */
  readonly context: GridContext;
  private detach: (() => void) | null = null;
  private readonly selectionListeners = new Set<(selection: GridSelection) => void>();
  private lastSelection: unknown = null;
  private lastSheet: SheetId | null = null;
  /** Set by the component: puts keyboard focus on the grid. */
  focusGrid: (() => void) | null = null;

  constructor(readonly session: SheetSession) {
    this.context = new GridContext(session);
  }

  /**
   * Starts following the session (undo jumps, sheet changes). Safe to call
   * again; `dispose` undoes it. `createSheetGridController` and the grid
   * component call it for you.
   */
  attach(): void {
    if (this.detach !== null) return;
    const stopSession = this.session.subscribe((event) => this.onSessionEvent(event));
    const stopStore = this.context.store.subscribe(() => this.emitSelection());
    this.detach = () => {
      stopSession();
      stopStore();
    };
  }

  /** Stops following the session. */
  dispose(): void {
    this.detach?.();
    this.detach = null;
  }

  private onSessionEvent(event: SessionEvent): void {
    const ctx = this.context;
    if (event.type === "state") {
      // The active sheet may have changed.
      this.emitSelection();
      return;
    }
    if (!isPasting(ctx)) clearCopyMark(ctx);
    if (event.cause === "load") {
      ctx.store.set({ edit: null, fill: null, menu: null });
      ctx.store.retain(this.session.sheets().map((sheet) => sheet.id));
    }
    if (event.cause !== "edit" && event.cause !== "layout") refreshFilter(ctx);
    if ((event.cause === "undo" || event.cause === "redo") && event.affected !== null) {
      if (event.affected.sheet !== ctx.sheet) this.session.setActiveSheet(event.affected.sheet);
      goToRange(ctx, event.affected);
    }
  }

  private emitSelection(): void {
    if (this.selectionListeners.size === 0) return;
    const sheet = this.context.sheet;
    const selection = this.context.selection;
    if (selection === this.lastSelection && sheet === this.lastSheet) return;
    this.lastSelection = selection;
    this.lastSheet = sheet;
    const snapshot = this.getSelection();
    for (const listener of [...this.selectionListeners]) listener(snapshot);
  }

  // ------------------------------------------------------------ selection and view

  getSelection(): GridSelection {
    const selection = this.context.selection;
    return { sheet: this.context.sheet, active: selection.active, ranges: selection.ranges };
  }

  /** The range being worked on, cut to cells that exist (a whole column is cut to the used rows). */
  getActiveRange(): CellRange {
    const range = activeRange(this.context.selection);
    if (range.kind === "cells") return { start: range.start, end: range.end };
    return this.context.usedRanges([range])[0] ?? { start: this.context.selection.active, end: this.context.selection.active };
  }

  /** Calls back when the selection or the active sheet changes. Returns the function that stops it. */
  onSelectionChange(listener: (selection: GridSelection) => void): () => void {
    if (this.selectionListeners.size >= MAX_SELECTION_LISTENERS) throw new Error("too many selection listeners");
    this.selectionListeners.add(listener);
    return () => {
      this.selectionListeners.delete(listener);
    };
  }

  /** Selects a cell or a range, switching to its sheet when given, and scrolls it into view. */
  select(target: CellAddress | CellRange, sheet?: SheetId): void {
    if (sheet !== undefined && sheet !== this.context.sheet) this.session.setActiveSheet(sheet);
    const range: CellRange = "start" in target ? target : { start: target, end: target };
    goToRange(this.context, range);
  }

  /** Scrolls a cell into view without changing the selection. */
  scrollTo(cell: CellAddress, sheet?: SheetId): void {
    if (sheet !== undefined && sheet !== this.context.sheet) this.session.setActiveSheet(sheet);
    this.context.reveal(cell);
  }

  /** Puts keyboard focus on the grid. */
  focus(): void {
    this.focusGrid?.();
  }

  // ------------------------------------------------------------ cells

  /** Sets a cell of the active sheet (or `sheet`) from text as typed. One undo step. */
  setCell(address: CellAddress, input: string, sheet: SheetId = this.context.sheet): EditResult {
    return this.session.setCellInput(sheet, address, input);
  }

  /** Applies several cell edits as one undo step. */
  applyEdits(edits: readonly SessionCellEdit[], label?: string): EditResult {
    return this.session.applyEdits(edits, label);
  }

  /** Empties the selected cells. */
  clear(what: "contents" | "formats" | "all" = "contents"): void {
    clearSelection(this.context, what);
  }

  /** Applies a style patch to the selection. */
  format(patch: CellStylePatch): void {
    styleSelection(this.context, patch);
  }

  toggleFormat(which: "bold" | "italic" | "underline"): void {
    toggleFormat(this.context, which);
  }

  /** Copies the first row of the selection down, or its first column to the right. */
  fill(direction: "down" | "right"): void {
    fillSelection(this.context, direction);
  }

  undo(): EditResult {
    const result = this.session.undo();
    report(this.context, result);
    return result;
  }

  redo(): EditResult {
    const result = this.session.redo();
    report(this.context, result);
    return result;
  }

  // ------------------------------------------------------------ editing

  get isEditing(): boolean {
    return this.context.store.getState().edit !== null;
  }

  /** Opens the editor on the active cell. `initial` replaces the content; without it the content is kept. */
  startEdit(initial?: string): void {
    startEdit(this.context, initial ?? null);
  }

  /** Stores the text being edited. False when it was refused and the editor stays open. */
  commitEdit(): boolean {
    return commitEdit(this.context, null);
  }

  /**
   * Runs `command` once the editor's text is stored. False, without running
   * it, when the editor refused the text. Every toolbar and menu command that
   * changes cells or the sheet goes through it.
   */
  afterEdit(command: () => void): boolean {
    return afterEditCommitted(this.context, command);
  }

  cancelEdit(): void {
    cancelEdit(this.context);
  }

  // ------------------------------------------------------------ clipboard

  /** The clipboard content for the selection, as text and as an HTML table; marks the cells as copied. */
  copy(): ClipboardPayload | null {
    return copySelection(this.context, false);
  }

  /** Like `copy`, and the cells are emptied when they are pasted. */
  cut(): ClipboardPayload | null {
    return copySelection(this.context, true);
  }

  /** Copy (or cut) started by a click: on the system clipboard when the browser allows it, else kept for pasting in this window. */
  copyToClipboard(cut = false): Promise<ClickCopyOutcome> {
    return clickCopy(this.context, cut);
  }

  /** Paste started by a click: the system clipboard, or else the cells last copied or cut in this window. */
  pasteFromClipboard(): Promise<ClickPasteOutcome> {
    return clickPaste(this.context);
  }

  /** Pastes clipboard text and HTML at the selection. */
  paste(data: { text?: string | null; html?: string | null }): boolean {
    return pasteClipboard(this.context, data);
  }

  // ------------------------------------------------------------ rows, columns, layout

  insertRows(where: "before" | "after" = "before"): void {
    insertRows(this.context, where);
  }

  deleteRows(): void {
    deleteRows(this.context);
  }

  insertColumns(where: "before" | "after" = "before"): void {
    insertColumns(this.context, where);
  }

  deleteColumns(): void {
    deleteColumns(this.context);
  }

  /** Merges the active range into one cell, or splits it again when it is merged. */
  toggleMerge(): void {
    const ctx = this.context;
    const range = this.getActiveRange();
    const merged = ctx.info().mergedRanges.some(
      (merge) => merge.start.row <= range.end.row && range.start.row <= merge.end.row && merge.start.col <= range.end.col && range.start.col <= merge.end.col,
    );
    report(ctx, merged ? this.session.unmergeCells(ctx.sheet, range) : this.session.mergeCells(ctx.sheet, range));
  }

  /** Freezes the rows above and the columns left of the active cell; a second call on A1, or when panes are frozen there already, releases them. */
  toggleFreeze(): void {
    const ctx = this.context;
    const active = ctx.selection.active;
    const frozen = ctx.info().frozen;
    const next = frozen.rows === active.row && frozen.cols === active.col ? { rows: 0, cols: 0 } : { rows: active.row, cols: active.col };
    report(ctx, this.session.setFrozenPanes(ctx.sheet, next));
  }

  // ------------------------------------------------------------ sort and filter

  /** Sorts the selected range, or the block of data around the active cell, by the active cell's column. */
  sort(descending = false): void {
    sortSelection(this.context, descending);
  }

  /** Sorts the rows of a range by the given columns. Without `hasHeader` the first row stays when it reads as labels. */
  sortRange(range: CellRange, keys: readonly SortKey[], hasHeader?: boolean): boolean {
    return sortRange(this.context, range, keys, hasHeader);
  }

  /** Hides the rows a filter rejects, in this view only; null shows all rows again. */
  filter(spec: FilterSpec | null): void {
    applyFilter(this.context, spec);
  }

  /** Keeps only the rows whose value in the active column equals the active cell's. */
  filterByValue(): void {
    filterByActiveValue(this.context);
  }

  get isFiltered(): boolean {
    return this.context.view.filter !== null;
  }

  // ------------------------------------------------------------ decorations

  /**
   * Marks cells. Each feature uses its own layer name; setting a layer
   * replaces what it held, and an empty list removes it.
   */
  decorate(layer: string, decorations: readonly CellDecoration[]): void {
    this.context.decorations.set(layer, decorations);
    this.context.store.set({ decorations: this.context.decorations.version });
  }

  /** Removes one layer of decorations, or all of them. */
  clearDecorations(layer?: string): void {
    this.context.decorations.clear(layer);
    this.context.store.set({ decorations: this.context.decorations.version });
  }
}

/** Creates the controller for a session. Pass it to `<SheetGrid controller={...} />` and keep it for toolbars and panels. */
export function createSheetGridController(session: SheetSession): SheetGridController {
  const controller = new SheetGridController(session);
  controller.attach();
  return controller;
}
