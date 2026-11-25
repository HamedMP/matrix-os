/**
 * Saving a session's workbook: explicit saves, save-as, and the debounced
 * automatic save.
 *
 * Rules:
 * - A write carries the version the file had when it was read. When the file
 *   changed on disk the bridge answers `version_conflict`; the controller then
 *   stops saving and waits for the owner to reload or to save a copy. Local
 *   edits stay in memory the whole time.
 * - Saves run one at a time, in the order they were asked for.
 * - A save that settles after the session was closed, or after the document
 *   was replaced by a reload, changes nothing: not the state, not the file.
 *   The automatic save checks the same before it starts.
 */

import {
  type CsvShape,
  SheetSessionError,
  copyPath,
  defaultCsvShape,
  formatOfPath,
  isValidFilePath,
  isVersionConflict,
  sessionMessage,
  toSessionError,
} from "./file-io";
import type { SaveOutcome, SaveState, SessionErrorCode, SessionFiles, SessionTimers, SheetFileFormat } from "./types";

export const DEFAULT_AUTOSAVE_DELAY_MS = 1000;
const MAX_AUTOSAVE_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_COPY_ATTEMPTS = 20;

export interface SaveHost {
  /** The workbook as file bytes. */
  serialize(format: SheetFileFormat, csv: CsvShape | null): Promise<Uint8Array>;
  /** Grows with every edit. */
  editSeq(): number;
  /** The controller's state changed; tell the listeners. */
  changed(): void;
  /** True while proposed changes wait for review: a values-only format cannot store them. */
  reviewPending(): boolean;
  log(message: string, error: unknown): void;
}

export interface SaveTarget {
  path: string | null;
  format: SheetFileFormat;
  version: string | null;
  csv: CsvShape | null;
}

export interface SaveControllerOptions {
  files: SessionFiles;
  timers: SessionTimers;
  now: () => number;
  delayMs: number;
}

export class SaveController {
  path: string | null;
  format: SheetFileFormat;
  version: string | null;
  csv: CsvShape | null;
  saveState: SaveState = "idle";
  saveError: { code: SessionErrorCode; message: string } | null = null;
  lastSavedAt: number | null = null;
  autosave = true;

  private savedSeq: number;
  private timer: unknown = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** Grows when the document is replaced (reload). A save started before does not apply after. */
  private epoch = 0;
  private disposed = false;
  private retries = 0;

  constructor(
    private readonly host: SaveHost,
    private readonly options: SaveControllerOptions,
    target: SaveTarget,
  ) {
    this.path = target.path;
    this.format = target.format;
    this.version = target.version;
    this.csv = target.csv;
    this.savedSeq = host.editSeq();
  }

  get dirty(): boolean {
    return this.host.editSeq() !== this.savedSeq;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Runs `task` after every save that was asked for before it. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    // The caller gets the rejection; the queue only needs to keep going after it.
    this.chain = run.then(
      () => undefined,
      (error: unknown) => this.host.log("a queued file operation failed", error),
    );
    return run;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.options.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (this.disposed || !this.autosave || this.path === null || this.saveState === "conflict") return;
    const epoch = this.epoch;
    this.timer = this.options.timers.set(() => {
      this.timer = null;
      if (this.disposed || epoch !== this.epoch) return;
      void this.enqueue(() => this.write(epoch, true));
    }, delayMs);
  }

  /** Called after every edit: marks the session as waiting to save and restarts the quiet period. */
  noteEdit(): void {
    if (this.disposed) return;
    this.retries = 0;
    if (this.saveState === "conflict") return;
    if (this.path !== null && this.autosave) {
      this.saveState = "pending";
      this.saveError = null;
      this.schedule(this.options.delayMs);
    } else if (this.saveState === "saved") {
      this.saveState = "idle";
    }
  }

  setAutosave(on: boolean): void {
    this.autosave = on;
    if (!on) {
      this.cancelTimer();
      if (this.saveState === "pending") this.saveState = "idle";
    } else if (this.dirty) {
      this.noteEdit();
    }
    this.host.changed();
  }

  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.epoch;
  }

  private fail(error: unknown, automatic: boolean): SaveOutcome {
    const mapped = toSessionError(error);
    this.host.log("save failed", error);
    this.saveState = "error";
    this.saveError = { code: mapped.code, message: mapped.message };
    if (automatic && mapped.code === "unavailable" && this.retries < MAX_AUTOSAVE_RETRIES) {
      this.retries += 1;
      this.schedule(Math.min(MAX_RETRY_DELAY_MS, this.options.delayMs * 2 ** this.retries));
    }
    this.host.changed();
    return { status: "error", code: mapped.code, message: mapped.message };
  }

  /**
   * A CSV or TSV file has no place for the change journal: written now, a
   * proposal would land in the file as an ordinary value before the owner
   * reviewed it. The save waits until the review is done or the owner saves
   * as .xlsx.
   */
  private blockedByReview(format: SheetFileFormat): boolean {
    return format !== "xlsx" && this.host.reviewPending();
  }

  private refuseForReview(): SaveOutcome {
    this.cancelTimer();
    this.saveState = "error";
    this.saveError = { code: "review_pending", message: sessionMessage("review_pending") };
    this.host.changed();
    return { status: "error", code: "review_pending", message: sessionMessage("review_pending") };
  }

  private async write(epoch: number, automatic: boolean): Promise<SaveOutcome> {
    if (this.stale(epoch)) return { status: "superseded" };
    if (this.saveState === "conflict") return { status: "conflict" };
    const path = this.path;
    if (path === null) return { status: "error", code: "invalid_path", message: sessionMessage("invalid_path") };
    if (this.dirty && this.blockedByReview(this.format)) return this.refuseForReview();
    if (!this.dirty) {
      if (this.saveState === "pending") {
        this.saveState = "idle";
        this.host.changed();
      }
      return { status: "unchanged" };
    }
    this.cancelTimer();
    const seq = this.host.editSeq();
    this.saveState = "saving";
    this.saveError = null;
    this.host.changed();
    let bytes: Uint8Array;
    try {
      bytes = await this.host.serialize(this.format, this.csv);
    } catch (error: unknown) {
      if (this.stale(epoch)) return { status: "superseded" };
      return this.fail(error, automatic);
    }
    // The document was closed or replaced while it was being serialised: these bytes are no longer wanted.
    if (this.stale(epoch)) return { status: "superseded" };
    try {
      const written = await this.options.files.write(path, bytes, { ifVersion: this.version });
      if (this.stale(epoch)) return { status: "superseded" };
      this.version = written.version;
    } catch (error: unknown) {
      if (this.stale(epoch)) return { status: "superseded" };
      if (isVersionConflict(error)) {
        this.cancelTimer();
        this.saveState = "conflict";
        this.saveError = null;
        this.host.changed();
        return { status: "conflict" };
      }
      return this.fail(error, automatic);
    }
    this.savedSeq = seq;
    this.retries = 0;
    this.lastSavedAt = this.options.now();
    if (this.dirty) {
      // Edits arrived while the file was being written.
      this.saveState = "pending";
      this.schedule(this.options.delayMs);
    } else {
      this.saveState = "saved";
    }
    this.host.changed();
    return { status: "saved", path };
  }

  /** Saves now. Resolves `conflict` without writing while a conflict is unresolved. */
  save(): Promise<SaveOutcome> {
    const epoch = this.epoch;
    return this.enqueue(() => this.write(epoch, false));
  }

  private async writeNew(epoch: number, path: string): Promise<SaveOutcome> {
    if (this.stale(epoch)) return { status: "superseded" };
    const format = formatOfPath(path);
    if (format === null || !isValidFilePath(path)) {
      return { status: "error", code: "invalid_path", message: sessionMessage("invalid_path") };
    }
    if (this.blockedByReview(format)) return { status: "error", code: "review_pending", message: sessionMessage("review_pending") };
    const csv = format === "xlsx" ? null : this.format === format && this.csv !== null ? this.csv : defaultCsvShape(format);
    const seq = this.host.editSeq();
    const previous = this.saveState;
    this.saveState = "saving";
    this.host.changed();
    try {
      const bytes = await this.host.serialize(format, csv);
      if (this.stale(epoch)) return { status: "superseded" };
      const written = await this.options.files.write(path, bytes, { ifVersion: null, createParents: true });
      if (this.stale(epoch)) return { status: "superseded" };
      this.cancelTimer();
      this.path = written.path;
      this.format = format;
      this.csv = csv;
      this.version = written.version;
      this.savedSeq = seq;
      this.retries = 0;
      this.lastSavedAt = this.options.now();
      this.saveError = null;
      this.saveState = "saved";
      if (this.dirty) this.noteEdit();
      this.host.changed();
      return { status: "saved", path: written.path };
    } catch (error: unknown) {
      if (this.stale(epoch)) return { status: "superseded" };
      // The state the session was in stays: a failed copy does not resolve a conflict.
      this.saveState = previous;
      this.host.changed();
      if (isVersionConflict(error)) return { status: "error", code: "exists", message: sessionMessage("exists") };
      const mapped = toSessionError(error);
      this.host.log("save as failed", error);
      return { status: "error", code: mapped.code, message: mapped.message };
    }
  }

  /**
   * Writes the workbook to a new path, which must not exist, and continues
   * there. The format follows the extension. Resolves a conflict.
   */
  saveAs(path: string): Promise<SaveOutcome> {
    const epoch = this.epoch;
    return this.enqueue(() => this.writeNew(epoch, path));
  }

  /** Saves beside the current file under the first free "(copy)" name and continues there. */
  saveCopy(): Promise<SaveOutcome> {
    const epoch = this.epoch;
    return this.enqueue(async () => {
      const base = this.path;
      if (base === null) return { status: "error", code: "invalid_path", message: sessionMessage("invalid_path") };
      let outcome: SaveOutcome = { status: "error", code: "exists", message: sessionMessage("exists") };
      for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt++) {
        outcome = await this.writeNew(epoch, copyPath(base, attempt));
        if (outcome.status !== "error" || outcome.code !== "exists") return outcome;
      }
      return outcome;
    });
  }

  /** The document was read again from disk: forget pending saves and the conflict. */
  adopt(target: SaveTarget): void {
    this.epoch += 1;
    this.cancelTimer();
    this.path = target.path;
    this.format = target.format;
    this.version = target.version;
    this.csv = target.csv;
    this.savedSeq = this.host.editSeq();
    this.retries = 0;
    this.saveState = "idle";
    this.saveError = null;
  }

  /** The edits so far were saved somewhere else (a download of a local file): the document counts as saved. */
  markSaved(): void {
    if (this.disposed) return;
    this.cancelTimer();
    this.savedSeq = this.host.editSeq();
    this.lastSavedAt = this.options.now();
    this.saveState = "saved";
    this.saveError = null;
    this.host.changed();
  }

  /** Saves pending edits now, if any and if nothing blocks it. */
  flush(): Promise<SaveOutcome> {
    if (this.path === null || !this.dirty) return Promise.resolve({ status: "unchanged" });
    return this.save();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }
}

export { SheetSessionError };
