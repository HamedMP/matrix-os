/**
 * One open spreadsheet: the engine workbook, its undo history and its file.
 * See `./index.ts` for how to use it.
 */

import {
  type Cell,
  type CellAddress,
  type CellRange,
  type CellStylePatch,
  type FrozenPanes,
  type RawCell,
  type ResolveChangesResult,
  type SheetId,
  type SheetInfo,
  type SheetRangeRef,
  type Workbook,
  isOfficeError,
} from "./engine";
import {
  MAX_TRANSACTION_CELLS,
  type SessionCellEdit,
  type Transaction,
  applyCellEdit,
  applyInputs,
  clampRange,
  inputCellCount,
  nextSheetName,
  rangeArea,
} from "./edits";
import { type LoadedWorkbook, SheetSessionError, fileName, loadWorkbook, serializeWorkbook } from "./file-io";
import { affectedRange } from "./history";
import { acceptedBy } from "./implicit-accept";
import { type RecentFiles, createRecentFiles } from "./recents";
import { Listeners } from "./listeners";
import { Recorder, transactionFor } from "./recorder";
import { ARRAY_MESSAGE, OK, PENDING_MESSAGE, failure } from "./results";
import { forEachStoredCell } from "./stored-cells";
import { DEFAULT_AUTOSAVE_DELAY_MS, SaveController, type SaveTarget } from "./save";
import type {
  DocumentSource,
  EditResult,
  SaveOutcome,
  SessionChangeCause,
  SessionDeps,
  SessionEvent,
  SessionListener,
  SessionState,
  SessionTimers,
  SheetFileFormat,
} from "./types";

const MAX_LISTENERS = 64;
const DEFAULT_TIMERS: SessionTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SheetSession {
  readonly recents: RecentFiles;
  private wb: Workbook;
  private recorder: Recorder;
  private readonly saver: SaveController;
  private readonly listeners: Listeners<SessionEvent>;
  private readonly now: () => number;
  private readonly log: (message: string, error: unknown) => void;
  private state: SessionState;
  private editSeq = 0;
  private revision = 0;
  private activeSheet: SheetId;
  private calcComplete = true;
  private untracked = false;
  private mutating = false;
  private disposed = false;
  private readonly unsavedName: string;
  /** Where a document without a path came from; a saved document is always `matrix`. */
  private origin: DocumentSource;

  /** `name` is the file name while there is no path; `source: "local"` turns autosave off until a copy is saved to Matrix. */
  constructor(
    private readonly deps: SessionDeps,
    loaded: LoadedWorkbook,
    target: Pick<SaveTarget, "path" | "format" | "version">,
    options: { name?: string; source?: DocumentSource } = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.listeners = new Listeners(MAX_LISTENERS, this.log);
    this.unsavedName = options.name ?? "Untitled.xlsx";
    this.origin = target.path === null ? (options.source ?? "matrix") : "matrix";
    this.wb = loaded.workbook;
    this.recorder = new Recorder(this.wb, () => this.onUntracked());
    this.activeSheet = this.firstVisibleSheet();
    this.recents = createRecentFiles(deps.db, { now: this.now, log: this.log });
    this.saver = new SaveController(
      {
        serialize: (format, csv) => serializeWorkbook(this.wb, format, csv),
        editSeq: () => this.editSeq,
        changed: () => this.refresh(true),
        reviewPending: () => this.wb.listChanges().length > 0,
        log: this.log,
      },
      { files: deps.files, timers: deps.timers ?? DEFAULT_TIMERS, now: this.now, delayMs: deps.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS },
      { ...target, csv: loaded.csv },
    );
    if (this.origin === "local") this.saver.autosave = false;
    this.state = this.buildState();
  }

  // ------------------------------------------------------------ reading

  /** The engine workbook. Read from it freely; edit through the session so that undo, calculation and saving follow. */
  get workbook(): Workbook {
    return this.wb;
  }

  getState(): SessionState {
    return this.state;
  }

  /** The version of the file this session last read or wrote, or null without a file. Changes with every save. */
  get fileVersion(): string | null {
    return this.saver.version;
  }

  /** Calls back after every change. Returns the function that stops it. */
  subscribe(listener: SessionListener): () => void {
    return this.listeners.add(listener);
  }

  sheets(): SheetInfo[] {
    return this.wb.listSheets();
  }

  sheet(id: SheetId): SheetInfo {
    return this.wb.getSheet(id);
  }

  cell(sheet: SheetId, row: number, col: number): Cell {
    return this.wb.getCell(sheet, { row, col });
  }

  /** Value, formula and style id without formatting: cheap enough for scans. */
  raw(sheet: SheetId, row: number, col: number): RawCell {
    return this.recorder.internals.readRawCell(sheet, { row, col });
  }

  isBlank(sheet: SheetId, row: number, col: number): boolean {
    const cell = this.raw(sheet, row, col);
    return cell.value === null && cell.formula === null;
  }

  setActiveSheet(id: SheetId): void {
    this.wb.getSheet(id);
    if (this.activeSheet === id) return;
    this.activeSheet = id;
    this.refresh(true);
  }

  // ------------------------------------------------------------ state and events

  private firstVisibleSheet(): SheetId {
    const sheets = this.wb.listSheets();
    const sheet = sheets.find((entry) => entry.state === "visible") ?? sheets[0];
    if (sheet === undefined) throw new SheetSessionError("corrupt");
    return sheet.id;
  }

  private buildState(): SessionState {
    const history = this.recorder.history;
    const path = this.saver.path;
    return {
      revision: this.revision,
      path,
      name: path === null ? this.unsavedName : fileName(path),
      source: path === null ? this.origin : "matrix",
      format: this.saver.format,
      dirty: this.saver.dirty,
      saveState: this.saver.saveState,
      saveError: this.saver.saveError,
      lastSavedAt: this.saver.lastSavedAt,
      autosave: this.saver.autosave,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
      activeSheetId: this.activeSheet,
      calcComplete: this.calcComplete,
      valuesOnlyFormat: this.saver.format !== "xlsx",
    };
  }

  private emit(event: SessionEvent): void {
    this.listeners.emit(event);
  }

  /** Replaces the state snapshot when a field changed. With `notify`, tells listeners about a state-only change. */
  private refresh(notify: boolean): void {
    if (this.disposed) return;
    const next = this.buildState();
    const previous = this.state as unknown as Record<string, unknown>;
    const changed = Object.entries(next).some(([key, value]) => previous[key] !== value);
    if (!changed) return;
    this.state = next;
    if (notify) this.emit({ type: "state" });
  }

  private afterChange(cause: SessionChangeCause, affected: SheetRangeRef | null): void {
    const result = this.wb.recalc({ now: new Date(this.now()).toISOString() });
    this.calcComplete = result.complete;
    this.revision += 1;
    if (cause !== "load") {
      this.editSeq += 1;
      this.saver.noteEdit();
    }
    // Only a change made around the session can remove the active sheet.
    if (cause !== "edit" && this.wb.listSheets().every((sheet) => sheet.id !== this.activeSheet)) this.activeSheet = this.firstVisibleSheet();
    this.refresh(false);
    this.emit({ type: "change", cause, recalculated: result.changed, affected });
  }

  private onUntracked(): void {
    if (this.mutating || this.untracked || this.disposed) return;
    this.untracked = true;
    queueMicrotask(() => {
      this.untracked = false;
      if (this.disposed) return;
      this.recorder.history.clear();
      this.afterChange("external", null);
    });
  }

  // ------------------------------------------------------------ transactions

  /**
   * Runs edits as one undoable step, then recalculates and tells listeners.
   * When `run` throws, everything it did is taken back and the failure is
   * returned. A call inside another transaction joins it.
   *
   * An edit that writes many cells claims them first with `tx.reserve`, so
   * that it is refused before it writes more than a failed step can put back.
   * Should part of a failed step stay in the workbook all the same, the
   * workbook counts as changed (and unsaved), and the history is dropped.
   */
  transact(label: string, run: (tx: Transaction) => void): EditResult {
    if (this.disposed) return failure(new SheetSessionError("failed"));
    if (this.recorder.active) {
      run(transactionFor(this.recorder, this.wb));
      return OK;
    }
    const pending = this.wb.listChanges();
    this.recorder.begin(label);
    try {
      run(transactionFor(this.recorder, this.wb));
    } catch (error: unknown) {
      let restored = false;
      try {
        // Changes accepted by writing over their cells are proposed again.
        restored = this.recorder.rollback(acceptedBy(pending, this.wb.listChanges()));
      } catch (rollbackError: unknown) {
        this.log("a failed edit could not be taken back", rollbackError);
        this.recorder.history.clear();
      }
      if (!isOfficeError(error) && !(error instanceof SheetSessionError)) this.log("an edit failed", error);
      // Part of the edit stayed: it must show as a change to save, never as the saved file.
      if (!restored) this.afterChange("external", null);
      return failure(error);
    }
    const committed = this.recorder.commit();
    // Writing over a proposed cell accepts its change; undo must bring it back for review.
    const accepted = committed.entry === null ? [] : acceptedBy(pending, this.wb.listChanges());
    if (accepted.length > 0) committed.entry?.steps.unshift({ kind: "accepted", changes: accepted });
    if (committed.changed) this.afterChange("edit", null);
    return OK;
  }

  /**
   * Runs a change that cannot be undone here: proposals, accepting and
   * rejecting changes, adding or removing a sheet. Clears the undo history.
   */
  mutate<T>(run: (workbook: Workbook) => T): T {
    if (this.disposed) throw new SheetSessionError("failed");
    this.mutating = true;
    try {
      return run(this.wb);
    } finally {
      this.mutating = false;
      this.recorder.history.clear();
      this.afterChange("external", null);
    }
  }

  private replay(direction: "undo" | "redo"): EditResult {
    if (this.disposed || this.recorder.active) return failure(new SheetSessionError("failed"));
    let entry;
    try {
      entry = direction === "undo" ? this.recorder.undo() : this.recorder.redo();
    } catch (error: unknown) {
      // The history no longer fits the workbook: drop it instead of failing again and again.
      this.log(`${direction} failed`, error);
      this.recorder.history.clear();
      this.afterChange("external", null);
      return failure(error);
    }
    if (entry === null) return OK;
    if (entry === "blocked") return failure(new SheetSessionError("not_allowed", { message: PENDING_MESSAGE }));
    this.afterChange(direction, affectedRange(entry));
    return OK;
  }

  undo(): EditResult {
    return this.replay("undo");
  }

  redo(): EditResult {
    return this.replay("redo");
  }

  // ------------------------------------------------------------ edits

  /** Sets a cell from text as typed. A formula that does not parse fails with `formula` and changes nothing. */
  setCellInput(sheet: SheetId, address: CellAddress, input: string): EditResult {
    const result = this.transact("Typing", (tx) => tx.workbook.setCellInput(sheet, address, input));
    if (result.ok || result.code !== "not_allowed") return result;
    try {
      if (this.wb.getCell(sheet, address).arrayRange !== null) return { ...result, message: ARRAY_MESSAGE };
    } catch (error: unknown) {
      // The address itself was refused: the general message stands.
      if (!isOfficeError(error)) throw error;
    }
    return result;
  }

  /** Writes rows of typed text from `start`. Text that looks like a formula but does not parse is kept as text. */
  setInputs(sheet: SheetId, start: CellAddress, rows: ReadonlyArray<ReadonlyArray<string>>, label = "Paste"): EditResult {
    return this.transact(label, (tx) => {
      tx.reserve(inputCellCount(start, rows));
      applyInputs(tx.workbook, sheet, start, rows);
    });
  }

  applyEdits(edits: readonly SessionCellEdit[], label = "Edit"): EditResult {
    return this.transact(label, (tx) => {
      tx.reserve(edits.length);
      for (const edit of edits) applyCellEdit(tx.workbook, edit);
    });
  }

  clear(sheet: SheetId, ranges: readonly CellRange[], what: "contents" | "formats" | "all" = "contents"): EditResult {
    return this.transact("Clear", (tx) => {
      tx.reserve(this.storedCells(sheet, ranges));
      for (const range of ranges) tx.workbook.clearRange(sheet, range, what);
    });
  }

  /**
   * The cells the sheet stores in `ranges` (clearing changes no other),
   * counted up to just past what one step may change. Where the stored cells
   * cannot be walked, every position of the range counts.
   */
  private storedCells(sheet: SheetId, ranges: readonly CellRange[]): number {
    let count = 0;
    for (const range of ranges) {
      let found = 0;
      const complete = forEachStoredCell(this.recorder.internals, sheet, range, () => ++found <= MAX_TRANSACTION_CELLS);
      count += complete ? found : Math.max(found, rangeArea(range));
      if (count > MAX_TRANSACTION_CELLS) return count;
    }
    return count;
  }

  /**
   * Applies a style patch. A whole-row or whole-column range is cut to the
   * used area plus a margin. Every range is cut and counted before the first
   * is written, so a refused range leaves the others as they were.
   */
  setStyle(sheet: SheetId, ranges: readonly CellRange[], patch: CellStylePatch): EditResult {
    return this.transact("Format", (tx) => {
      const cut = ranges.map((range) => clampRange(tx.workbook, sheet, range));
      tx.reserve(cut.reduce((sum, range) => sum + rangeArea(range), 0));
      for (const range of cut) tx.workbook.setStyle(sheet, range, patch);
    });
  }

  /** Rows and columns cannot move while the sheet has proposed changes waiting: say so instead of a general refusal. */
  private structural(sheet: SheetId, label: string, run: (tx: Transaction) => void): EditResult {
    const result = this.transact(label, run);
    if (result.ok || result.code !== "not_allowed" || this.wb.getSheet(sheet).pendingChangeCount === 0) return result;
    return { ...result, message: PENDING_MESSAGE };
  }

  insertRows(sheet: SheetId, index: number, count: number): EditResult {
    return this.structural(sheet, "Insert rows", (tx) => tx.insertRows(sheet, index, count));
  }

  deleteRows(sheet: SheetId, index: number, count: number): EditResult {
    return this.structural(sheet, "Delete rows", (tx) => tx.deleteRows(sheet, index, count));
  }

  insertColumns(sheet: SheetId, index: number, count: number): EditResult {
    return this.structural(sheet, "Insert columns", (tx) => tx.insertColumns(sheet, index, count));
  }

  deleteColumns(sheet: SheetId, index: number, count: number): EditResult {
    return this.structural(sheet, "Delete columns", (tx) => tx.deleteColumns(sheet, index, count));
  }

  setColumnWidths(sheet: SheetId, cols: readonly number[], width: number | null): EditResult {
    return this.transact("Column width", (tx) => tx.setColumnWidths(sheet, cols, width));
  }

  setRowHeights(sheet: SheetId, rows: readonly number[], heightPt: number | null): EditResult {
    return this.transact("Row height", (tx) => tx.setRowHeights(sheet, rows, heightPt));
  }

  mergeCells(sheet: SheetId, range: CellRange): EditResult { return this.transact("Merge cells", (tx) => tx.mergeCells(sheet, range)); }
  unmergeCells(sheet: SheetId, range: CellRange): EditResult { return this.transact("Unmerge cells", (tx) => tx.unmergeCells(sheet, range)); }
  setFrozenPanes(sheet: SheetId, frozen: FrozenPanes): EditResult { return this.transact("Freeze panes", (tx) => tx.setFrozenPanes(sheet, frozen)); }
  renameSheet(sheet: SheetId, name: string): EditResult { return this.transact("Rename sheet", (tx) => tx.renameSheet(sheet, name)); }

  /** Adds a sheet and makes it active. Not undoable; clears the undo history. */
  addSheet(name?: string): EditResult & { sheet?: SheetId } {
    try {
      const wanted = name ?? nextSheetName(this.wb);
      const added = this.mutate((workbook) => workbook.addSheet(wanted));
      this.setActiveSheet(added.id);
      return { ok: true, sheet: added.id };
    } catch (error: unknown) {
      return failure(error);
    }
  }

  /** Removes a sheet. Not undoable; clears the undo history. */
  removeSheet(sheet: SheetId): EditResult {
    try {
      this.mutate((workbook) => workbook.removeSheet(sheet));
      return OK;
    } catch (error: unknown) {
      return failure(error);
    }
  }

  /** Accepts proposed changes, then recalculates. Not undoable. */
  acceptChanges(ids: readonly string[] | "all"): ResolveChangesResult {
    return this.mutate((workbook) => workbook.acceptChanges(ids));
  }

  /** Rejects proposed changes, then recalculates. Not undoable. */
  rejectChanges(ids: readonly string[] | "all"): ResolveChangesResult {
    return this.mutate((workbook) => workbook.rejectChanges(ids));
  }

  // ------------------------------------------------------------ file

  /** Saves to the file's path. `conflict` means the file changed on disk: offer {@link reload} or {@link saveCopy}. */
  save(): Promise<SaveOutcome> {
    return this.saver.save();
  }

  /** Saves under a new path, which must not exist yet, and continues there. The extension decides the format. */
  async saveAs(path: string): Promise<SaveOutcome> {
    const outcome = await this.saver.saveAs(path);
    if (outcome.status !== "saved") return outcome;
    void this.recents.touch(outcome.path);
    // A local document saved to Matrix is a Matrix document from now on.
    if (this.origin === "local") {
      this.origin = "matrix";
      this.saver.setAutosave(true);
    }
    return outcome;
  }

  /** Saves beside the file as "name (copy).xlsx" and continues there. Resolves a conflict without losing edits. */
  async saveCopy(): Promise<SaveOutcome> {
    const outcome = await this.saver.saveCopy();
    if (outcome.status === "saved") void this.recents.touch(outcome.path);
    return outcome;
  }

  /** Saves pending edits now. Call before closing the session. */
  flush(): Promise<SaveOutcome> {
    return this.saver.flush();
  }

  setAutosave(on: boolean): void {
    this.saver.setAutosave(on);
  }

  /** The workbook as file bytes in `format` (default its own), with the delimiter it was read with. */
  serialize(format: SheetFileFormat = this.saver.format): Promise<Uint8Array> {
    return serializeWorkbook(this.wb, format, format === this.saver.format ? this.saver.csv : null);
  }

  /** Grows with every edit; read before an export and passed to `markDownloaded` after it. */
  editMark(): number {
    return this.editSeq;
  }

  /** A local document's edits up to `mark` were downloaded: those count as saved, later ones stay unsaved. */
  markDownloaded(mark: number = this.editSeq): void {
    if (this.disposed || this.getState().source !== "local") return;
    this.saver.markSaved(Math.min(mark, this.editSeq));
  }

  /** Calculates out-of-date and volatile formulas now. Not an edit: nothing is marked unsaved. */
  recalculate(): void {
    if (this.disposed) return;
    const result = this.wb.recalc({ now: new Date(this.now()).toISOString() });
    this.calcComplete = result.complete;
    this.revision += 1;
    this.refresh(false);
    this.emit({ type: "change", cause: "layout", recalculated: result.changed, affected: null });
  }

  /**
   * Reads the file again and replaces the workbook, dropping local edits and
   * the undo history. When reading fails the local workbook stays as it is.
   */
  reload(): Promise<EditResult> {
    return this.saver.enqueue(async () => {
      const path = this.saver.path;
      if (this.disposed || path === null) return failure(new SheetSessionError("failed"));
      try {
        const content = await this.deps.files.read(path);
        const loaded = await loadWorkbook(content.bytes, this.saver.format);
        // Closed while reading: this document is no longer the one on screen.
        if (this.disposed) return failure(new SheetSessionError("failed"));
        const activeName = this.wb.getSheet(this.activeSheet).name;
        this.recorder.detach();
        this.wb = loaded.workbook;
        this.recorder = new Recorder(this.wb, () => this.onUntracked());
        this.activeSheet = this.wb.getSheetByName(activeName)?.id ?? this.firstVisibleSheet();
        this.saver.adopt({ path, format: this.saver.format, version: content.version, csv: loaded.csv });
        this.afterChange("load", null);
        return OK;
      } catch (error: unknown) {
        this.log("reload failed", error);
        return failure(error);
      }
    });
  }

  /** Stops timers and listeners. Pending edits are not saved: call {@link flush} first. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.saver.dispose();
    this.recorder.detach();
    this.listeners.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
