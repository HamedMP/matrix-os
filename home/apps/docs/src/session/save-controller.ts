/**
 * Saving for the document session: explicit saves, save-as, save-a-copy and
 * the debounced autosave.
 *
 * Rules it keeps:
 * - A write always carries the version the session last read or wrote, so a
 *   file changed by someone else is never overwritten silently.
 * - On `version_conflict` the local document stays as it is; the session shows
 *   a conflict until the owner reloads or saves a copy.
 * - A local document (opened from the computer) has no path: autosave skips
 *   it, and its Save is `download(true)`, which hands the bytes to the browser.
 * - Saves run one at a time. Each one belongs to the document that was active
 *   when it was requested and does nothing to the session once another
 *   document has taken its place.
 */

import type { BridgeFileWriteResult } from "../../../_shared/matrix-os";
import type { DocxDocument } from "../../../_shared/office-engine/index";
import { isBridgeFileError, sessionError, toSessionError } from "./errors";
import { copyPath, downloadName, fileName, isBridgePath } from "./paths";
import type { SaveAsOptions, SaveResult, SessionError, SessionFiles, SessionState } from "./types";

const MAX_COPY_ATTEMPTS = 50;

/** What the controller needs from the session. */
export interface SaveHost {
  getState(): SessionState;
  getDocument(): DocxDocument | null;
  /** Identifies the active document. */
  getToken(): number;
  isDisposed(): boolean;
  /** Number of the document state right now (see `History`). */
  currentStateId(): number;
  /** Writes the Track changes toggle into the document before it is serialised. */
  syncTracking(): void;
  patch(partial: Partial<SessionState>): void;
  /** The given state is now what the file holds. */
  markSaved(stateId: number, tracking: boolean): void;
  isDirty(): boolean;
  /** The document continues under a new path. */
  pathBound(path: string): void;
}

export interface SaveControllerOptions {
  files: SessionFiles;
  /** Hands a serialised document to the browser as a download. May throw when the browser refuses. */
  download: (name: string, bytes: Uint8Array) => void;
  host: SaveHost;
  delayMs: number;
  now: () => Date;
  log: (message: string, error: unknown) => void;
}

type Attempt =
  | { kind: "written"; result: BridgeFileWriteResult }
  /** The version check failed: the file changed, or exists where none was expected. */
  | { kind: "mismatch" }
  | { kind: "inactive" }
  | { kind: "failed"; error: SessionError };

interface Snapshot {
  doc: DocxDocument;
  token: number;
  stateId: number;
  tracking: boolean;
  bytes: Uint8Array;
}

export class SaveController {
  private readonly files: SessionFiles;
  private readonly sendDownload: (name: string, bytes: Uint8Array) => void;
  private readonly host: SaveHost;
  private readonly delayMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string, error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: SaveControllerOptions) {
    this.files = options.files;
    this.sendDownload = options.download;
    this.host = options.host;
    this.delayMs = options.delayMs;
    this.now = options.now;
    this.log = options.log;
  }

  /** Arms (or re-arms) the autosave timer when there is something autosave may write. */
  schedule(): void {
    this.cancel();
    const { host } = this;
    const state = host.getState();
    if (host.isDisposed() || !state.autosave || host.getDocument() === null) return;
    if (state.path === null || state.conflict !== null || !host.isDirty()) return;
    const token = host.getToken();
    this.timer = setTimeout(() => {
      this.timer = null;
      // The document this timer was armed for is no longer the active one.
      if (host.isDisposed() || token !== host.getToken()) return;
      void this.save();
    }, this.delayMs);
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when every save requested so far has settled. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  save(): Promise<SaveResult> {
    const token = this.host.getToken();
    return this.enqueue(async () => {
      const state = this.host.getState();
      const doc = this.host.getDocument();
      if (doc === null) return { status: "skipped", reason: "no_document" };
      if (token !== this.host.getToken()) return { status: "skipped", reason: "not_active" };
      if (state.path === null) return { status: "skipped", reason: "no_path" };
      if (state.conflict !== null) return { status: "conflict", path: state.conflict.path };
      if (!this.host.isDirty()) return { status: "skipped", reason: "clean" };
      const path = state.path;
      const snapshot = await this.serialise(doc, token);
      if (snapshot === null) return { status: "skipped", reason: "not_active" };
      if ("error" in snapshot) return this.failed(snapshot.error);
      const attempt = await this.attempt(snapshot, path, state.version, false);
      if (attempt.kind === "mismatch") {
        this.host.patch({ saveStatus: "conflict", saveError: null, conflict: { path, detectedAt: this.now().toISOString() } });
        return { status: "conflict", path };
      }
      return this.finish(snapshot, path, attempt);
    });
  }

  saveAs(path: string, options: SaveAsOptions = {}): Promise<SaveResult> {
    const token = this.host.getToken();
    return this.enqueue(async () => {
      const doc = this.host.getDocument();
      if (doc === null) return { status: "skipped", reason: "no_document" };
      if (token !== this.host.getToken()) return { status: "skipped", reason: "not_active" };
      if (!isBridgePath(path)) return { status: "error", error: sessionError("invalid_request") };
      let ifVersion: string | null = null;
      if (options.overwrite === true) {
        try {
          ifVersion = (await this.files.stat(path)).version;
        } catch (error) {
          if (!isBridgeFileError(error, "not_found")) {
            this.log("docs: could not check the target file", error);
            return this.failed(toSessionError(error));
          }
        }
        if (token !== this.host.getToken()) return { status: "skipped", reason: "not_active" };
      }
      const snapshot = await this.serialise(doc, token);
      if (snapshot === null) return { status: "skipped", reason: "not_active" };
      if ("error" in snapshot) return this.failed(snapshot.error);
      const attempt = await this.attempt(snapshot, path, ifVersion, true);
      if (attempt.kind === "mismatch") return this.failed(sessionError(ifVersion === null ? "already_exists" : "version_conflict"));
      return this.finish(snapshot, path, attempt);
    });
  }

  saveCopy(path?: string): Promise<SaveResult> {
    if (path !== undefined) return this.saveAs(path);
    const token = this.host.getToken();
    return this.enqueue(async () => {
      const doc = this.host.getDocument();
      const base = this.host.getState().path;
      if (doc === null) return { status: "skipped", reason: "no_document" };
      if (token !== this.host.getToken()) return { status: "skipped", reason: "not_active" };
      if (base === null) return { status: "skipped", reason: "no_path" };
      const snapshot = await this.serialise(doc, token);
      if (snapshot === null) return { status: "skipped", reason: "not_active" };
      if ("error" in snapshot) return this.failed(snapshot.error);
      for (let number = 1; number <= MAX_COPY_ATTEMPTS; number++) {
        const candidate = copyPath(base, number);
        const attempt = await this.attempt(snapshot, candidate, null, true);
        if (attempt.kind !== "mismatch") return this.finish(snapshot, candidate, attempt);
      }
      return this.failed(sessionError("already_exists"));
    });
  }

  /**
   * Serialises the document and downloads it under its name. With `asSave`
   * (the Save of a local document) the document is then clean; otherwise
   * (Download a copy) the save state is left as it is.
   */
  download(asSave: boolean): Promise<SaveResult> {
    const token = this.host.getToken();
    return this.enqueue(async () => {
      const doc = this.host.getDocument();
      if (doc === null) return { status: "skipped", reason: "no_document" };
      if (token !== this.host.getToken()) return { status: "skipped", reason: "not_active" };
      const name = downloadName(this.host.getState().name);
      const snapshot = await this.serialise(doc, token, !asSave);
      if (snapshot === null) return { status: "skipped", reason: "not_active" };
      if ("error" in snapshot) return asSave ? this.failed(snapshot.error) : { status: "error", error: snapshot.error };
      try {
        this.sendDownload(name, snapshot.bytes);
      } catch (error) {
        this.log("docs: the download could not start", error);
        return asSave ? this.failed(sessionError("unknown")) : { status: "error", error: sessionError("unknown") };
      }
      if (asSave) {
        this.host.markSaved(snapshot.stateId, snapshot.tracking);
        this.host.patch({ saveStatus: "saved", saveError: null, lastSavedAt: this.now().toISOString(), dirty: this.host.isDirty() });
      }
      return { status: "downloaded", name };
    });
  }

  /** The document as bytes. `quiet` (a copy) leaves the save state and the autosave timer alone. */
  private async serialise(doc: DocxDocument, token: number, quiet = false): Promise<Snapshot | { error: SessionError } | null> {
    if (!quiet) {
      this.cancel();
      this.host.patch({ saveStatus: "saving", saveError: null });
    }
    this.host.syncTracking();
    const stateId = this.host.currentStateId();
    const tracking = this.host.getState().tracking;
    try {
      const bytes = await doc.save();
      // Another document took over while this one was being serialised: do not write it.
      if (token !== this.host.getToken() || this.host.isDisposed()) return null;
      return { doc, token, stateId, tracking, bytes };
    } catch (error) {
      if (token !== this.host.getToken() || this.host.isDisposed()) return null;
      this.log("docs: could not serialise the document", error);
      return { error: toSessionError(error) };
    }
  }

  private async attempt(snapshot: Snapshot, path: string, ifVersion: string | null, createParents: boolean): Promise<Attempt> {
    try {
      const result = await this.files.write(path, snapshot.bytes, { ifVersion, createParents });
      return { kind: "written", result };
    } catch (error) {
      if (snapshot.token !== this.host.getToken() || this.host.isDisposed()) return { kind: "inactive" };
      if (isBridgeFileError(error, "version_conflict")) return { kind: "mismatch" };
      this.log("docs: could not write the document", error);
      return { kind: "failed", error: toSessionError(error) };
    }
  }

  private finish(snapshot: Snapshot, path: string, attempt: Exclude<Attempt, { kind: "mismatch" }>): SaveResult {
    if (attempt.kind === "inactive") return { status: "skipped", reason: "not_active" };
    if (attempt.kind === "failed") return this.failed(attempt.error);
    const { result } = attempt;
    const saved: SaveResult = { status: "saved", path: result.path, version: result.version };
    // The write is on disk, but the session has moved on to another document.
    if (snapshot.token !== this.host.getToken() || this.host.isDisposed()) return saved;
    const previousPath = this.host.getState().path;
    this.host.markSaved(snapshot.stateId, snapshot.tracking);
    this.host.patch({
      // A document written to the home is a Matrix document from now on, wherever it came from.
      source: "matrix",
      path,
      name: fileName(path),
      version: result.version,
      saveStatus: "saved",
      saveError: null,
      conflict: null,
      lastSavedAt: this.now().toISOString(),
      dirty: this.host.isDirty(),
    });
    if (previousPath !== path) this.host.pathBound(path);
    this.schedule();
    return saved;
  }

  private failed(error: SessionError): SaveResult {
    // An open conflict stays the headline; a failed way out of it is reported beside it.
    const inConflict = this.host.getState().conflict !== null;
    this.host.patch({ saveStatus: inConflict ? "conflict" : "error", saveError: error });
    return { status: "error", error };
  }

  private enqueue(task: () => Promise<SaveResult>): Promise<SaveResult> {
    const run = this.chain.then(task).catch((error: unknown): SaveResult => {
      this.log("docs: saving failed unexpectedly", error);
      return { status: "error", error: sessionError("unknown") };
    });
    this.chain = run.then(() => undefined);
    return run;
  }
}
