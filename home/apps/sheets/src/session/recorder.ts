/**
 * Records what an edit changes so that it can be undone.
 *
 * The recorder listens to the engine's cell mutations. Between `begin` and
 * `commit` every changed cell is kept once, with its content before the first
 * change and after the last. Structure and layout edits go through the
 * recorder's own methods, which make the change and note how to reverse it.
 *
 * A mutation that arrives outside a transaction (someone edited the workbook
 * directly) is reported through `onUntracked`; the session then clears the
 * history, because the recorded steps no longer describe the workbook.
 */

import {
  type CellChange,
  type CellMutation,
  type CellRange,
  type FrozenPanes,
  type RawCell,
  type SheetId,
  type Workbook,
  type WorkbookInternals,
  getWorkbookInternals,
} from "./engine";
import type { Transaction } from "./edits";
import {
  type BandCell,
  type CellDelta,
  type DeletedBand,
  History,
  type HistoryEntry,
  type HistoryStep,
  applyEntry,
  structuralSheets,
} from "./history";

/** Most cells one transaction may change and still be undoable. */
export const MAX_TRANSACTION_CELLS = 500_000;

interface OpenTransaction {
  label: string;
  steps: HistoryStep[];
  cells: Map<string, CellDelta>;
  /** True when the transaction changed more cells than the history keeps. */
  overflow: boolean;
}

function sameRaw(a: RawCell, b: RawCell): boolean {
  if (a.formula !== b.formula || a.styleId !== b.styleId) return false;
  if (a.value === b.value) return true;
  if (a.value !== null && b.value !== null && typeof a.value === "object" && typeof b.value === "object") {
    return a.value.code === b.value.code;
  }
  return false;
}

export class Recorder {
  readonly history = new History();
  readonly internals: WorkbookInternals;
  private readonly stop: () => void;
  private open: OpenTransaction | null = null;
  /** True while undo, redo or a rollback writes to the workbook. */
  private replaying = false;
  /** Where rewrite mutations go during a structural edit: a list, or null to drop them. */
  private rewrites: CellDelta[] | null | undefined = undefined;

  constructor(
    readonly workbook: Workbook,
    private readonly onUntracked: () => void,
  ) {
    this.internals = getWorkbookInternals(workbook);
    this.stop = this.internals.onCellMutation((mutation) => this.onMutation(mutation));
  }

  detach(): void {
    this.stop();
  }

  get active(): boolean {
    return this.open !== null;
  }

  private onMutation(mutation: CellMutation): void {
    if (this.replaying) return;
    if (mutation.reason === "rewrite" && this.rewrites !== undefined) {
      this.rewrites?.push({ sheet: mutation.sheet, row: mutation.row, col: mutation.col, before: mutation.before, after: mutation.after });
      return;
    }
    const open = this.open;
    if (open === null) {
      this.onUntracked();
      return;
    }
    const key = `${mutation.sheet}|${mutation.row}|${mutation.col}`;
    const known = open.cells.get(key);
    if (known !== undefined) {
      known.after = mutation.after;
      return;
    }
    if (open.cells.size >= MAX_TRANSACTION_CELLS) {
      open.overflow = true;
      return;
    }
    open.cells.set(key, { sheet: mutation.sheet, row: mutation.row, col: mutation.col, before: mutation.before, after: mutation.after });
  }

  begin(label: string): void {
    if (this.open !== null) throw new Error("a transaction is already open");
    this.open = { label, steps: [], cells: new Map(), overflow: false };
  }

  /** Closes the cell changes gathered so far into a step, so that a structural step can follow. */
  private flushCells(open: OpenTransaction): void {
    if (open.cells.size === 0) return;
    const deltas: CellDelta[] = [];
    for (const delta of open.cells.values()) if (!sameRaw(delta.before, delta.after)) deltas.push(delta);
    open.cells = new Map();
    if (deltas.length > 0) open.steps.push({ kind: "cells", deltas });
  }

  private requireOpen(): OpenTransaction {
    if (this.open === null) throw new Error("no transaction is open");
    return this.open;
  }

  /**
   * Ends the transaction. Returns the entry that went on the undo stack, or
   * null when nothing changed. `changed` is true when the workbook changed,
   * also when the change was too large to be kept for undo.
   */
  commit(): { entry: HistoryEntry | null; changed: boolean } {
    const open = this.requireOpen();
    this.flushCells(open);
    this.open = null;
    if (open.overflow) {
      this.history.clear();
      return { entry: null, changed: true };
    }
    if (open.steps.length === 0) return { entry: null, changed: false };
    const entry: HistoryEntry = { label: open.label, steps: open.steps };
    this.history.push(entry);
    return { entry, changed: true };
  }

  /**
   * Takes back everything the open transaction did and drops it. `accepted`
   * are the proposed changes it accepted by writing over their cells; they
   * are proposed again, so they stay pending for review.
   */
  rollback(accepted: readonly CellChange[] = []): void {
    const open = this.requireOpen();
    this.flushCells(open);
    this.open = null;
    const steps: HistoryStep[] = accepted.length > 0 ? [{ kind: "accepted", changes: [...accepted] }, ...open.steps] : open.steps;
    this.replay(() => applyEntry(this.internals, { label: open.label, steps }, false));
    if (open.overflow) this.history.clear();
  }

  private replay(run: () => void): void {
    this.replaying = true;
    try {
      run();
    } finally {
      this.replaying = false;
    }
  }

  private captureBand(sheet: SheetId, axis: "row" | "col", index: number, count: number): Omit<DeletedBand, "rewrites"> {
    const info = this.workbook.getSheet(sheet);
    const cells: BandCell[] = [];
    const used = info.dimensions;
    if (used !== null) {
      const rowStart = axis === "row" ? Math.max(index, used.start.row) : used.start.row;
      const rowEnd = axis === "row" ? Math.min(index + count - 1, used.end.row) : used.end.row;
      const colStart = axis === "col" ? Math.max(index, used.start.col) : used.start.col;
      const colEnd = axis === "col" ? Math.min(index + count - 1, used.end.col) : used.end.col;
      for (let row = rowStart; row <= rowEnd; row++) {
        for (let col = colStart; col <= colEnd; col++) {
          const cell = this.internals.readRawCell(sheet, { row, col });
          if (cell.value !== null || cell.formula !== null || cell.styleId !== 0) cells.push({ row, col, cell });
        }
      }
    }
    const sizes: Array<{ index: number; size: number }> = [];
    if (axis === "row") {
      for (const row of info.rows) if (row.index >= index && row.index < index + count) sizes.push({ index: row.index, size: row.heightPt });
    } else {
      for (const col of info.columns) if (col.index >= index && col.index < index + count) sizes.push({ index: col.index, size: col.width });
    }
    return { cells, sizes, merges: info.mergedRanges, names: this.workbook.listDefinedNames() };
  }

  /** Inserts or deletes rows or columns inside the open transaction. */
  axis(sheet: SheetId, axis: "row" | "col", index: number, count: number, insert: boolean): void {
    const open = this.requireOpen();
    this.flushCells(open);
    const workbook = this.workbook;
    if (insert) {
      this.rewrites = null;
      try {
        if (axis === "row") workbook.insertRows(sheet, index, count);
        else workbook.insertColumns(sheet, index, count);
      } finally {
        this.rewrites = undefined;
      }
      open.steps.push({ kind: "axis", sheet, axis, index, count, insert: true });
      return;
    }
    const band = this.captureBand(sheet, axis, index, count);
    const rewrites: CellDelta[] = [];
    this.rewrites = rewrites;
    try {
      if (axis === "row") workbook.deleteRows(sheet, index, count);
      else workbook.deleteColumns(sheet, index, count);
    } finally {
      this.rewrites = undefined;
    }
    open.steps.push({ kind: "axis", sheet, axis, index, count, insert: false, band: { ...band, rewrites } });
  }

  /** Sets row heights (points) or column widths (characters); null restores the default. */
  sizes(sheet: SheetId, axis: "row" | "col", indexes: readonly number[], size: number | null): void {
    const open = this.requireOpen();
    const info = this.workbook.getSheet(sheet);
    const changes: Array<{ index: number; before: number | null; after: number | null }> = [];
    const current = new Map<number, number>();
    if (axis === "row") for (const row of info.rows) current.set(row.index, row.heightPt);
    else for (const col of info.columns) current.set(col.index, col.width);
    for (const index of indexes) {
      const before = current.get(index) ?? null;
      if (before === size) continue;
      if (axis === "row") this.workbook.setRowHeight(sheet, index, size);
      else this.workbook.setColumnWidth(sheet, index, size);
      changes.push({ index, before, after: size });
    }
    if (changes.length === 0) return;
    this.flushCells(open);
    open.steps.push({ kind: "size", sheet, axis, changes });
  }

  /** Runs `change`, which merges or unmerges ranges of the sheet, and notes the merged ranges before and after. */
  merges(sheet: SheetId, change: () => void): void {
    const open = this.requireOpen();
    const before: CellRange[] = this.workbook.getSheet(sheet).mergedRanges;
    change();
    const after: CellRange[] = this.workbook.getSheet(sheet).mergedRanges;
    this.flushCells(open);
    if (JSON.stringify(before) !== JSON.stringify(after)) open.steps.push({ kind: "merges", sheet, before, after });
  }

  frozen(sheet: SheetId, frozen: FrozenPanes): void {
    const open = this.requireOpen();
    const before = this.workbook.getSheet(sheet).frozen;
    if (before.rows === frozen.rows && before.cols === frozen.cols) return;
    this.workbook.setFrozenPanes(sheet, frozen);
    this.flushCells(open);
    open.steps.push({ kind: "frozen", sheet, before: { ...before }, after: { ...frozen } });
  }

  rename(sheet: SheetId, name: string): void {
    const open = this.requireOpen();
    const before = this.workbook.getSheet(sheet).name;
    if (before === name) return;
    this.rewrites = null;
    try {
      this.workbook.renameSheet(sheet, name);
    } finally {
      this.rewrites = undefined;
    }
    this.flushCells(open);
    open.steps.push({ kind: "rename", sheet, before, after: name });
  }

  /** True when an entry cannot be replayed now: one of its sheets has pending changes, which block structural edits. */
  private blocked(entry: HistoryEntry): boolean {
    for (const sheet of structuralSheets(entry)) {
      if (this.workbook.getSheet(sheet).pendingChangeCount > 0) return true;
    }
    return false;
  }

  /** Takes back the last entry. Returns it, null when there is none, or `"blocked"`. */
  undo(): HistoryEntry | null | "blocked" {
    const entry = this.history.peekUndo();
    if (entry === null) return null;
    if (this.blocked(entry)) return "blocked";
    this.replay(() => applyEntry(this.internals, entry, false));
    this.history.settleUndo();
    return entry;
  }

  redo(): HistoryEntry | null | "blocked" {
    const entry = this.history.peekRedo();
    if (entry === null) return null;
    if (this.blocked(entry)) return "blocked";
    this.replay(() => applyEntry(this.internals, entry, true));
    this.history.settleRedo();
    return entry;
  }
}

/** The edits a session transaction offers, recorded for undo. */
export function transactionFor(recorder: Recorder, workbook: Workbook): Transaction {
  return {
    workbook,
    insertRows: (sheet, index, count) => recorder.axis(sheet, "row", index, count, true),
    deleteRows: (sheet, index, count) => recorder.axis(sheet, "row", index, count, false),
    insertColumns: (sheet, index, count) => recorder.axis(sheet, "col", index, count, true),
    deleteColumns: (sheet, index, count) => recorder.axis(sheet, "col", index, count, false),
    setColumnWidths: (sheet, cols, width) => recorder.sizes(sheet, "col", cols, width),
    setRowHeights: (sheet, rows, heightPt) => recorder.sizes(sheet, "row", rows, heightPt),
    mergeCells: (sheet, range) => recorder.merges(sheet, () => workbook.mergeCells(sheet, range)),
    unmergeCells: (sheet, range) => recorder.merges(sheet, () => workbook.unmergeCells(sheet, range)),
    setFrozenPanes: (sheet, frozen) => recorder.frozen(sheet, frozen),
    renameSheet: (sheet, name) => recorder.rename(sheet, name),
  };
}
