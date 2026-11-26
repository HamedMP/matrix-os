/**
 * The document session: one open `.docx`, its engine handle, the undo
 * history, and the state a view needs. Editing lives in
 * `./edit-controller.ts` and saving in `./save-controller.ts`.
 * See `./index.ts` for how to use it.
 */

import type { ApplyResult, DocxDocument, DocxOp, ResolveRevisionsResult, RevisionId } from "../../../_shared/office-engine/index";
// The Word module alone: the root index would pull the workbook and formula engine into Docs.
import { createDocx, openDocx } from "../../../_shared/office-engine/docx/index";
// Plain browser download helper; the module has no React or bridge dependency.
import { DOCX_MIME, downloadBytes } from "../../../_shared/office-ui/local-files";
import { emptyChange } from "./changes";
import { EditController } from "./edit-controller";
import { sessionError, toSessionError } from "./errors";
import { DEFAULT_UNDO_LIMIT, History } from "./history";
import { fileName, isBridgePath, localFileName } from "./paths";
import type { RecentFilesStore } from "./recent-files";
import { trackSelectionThroughResolve } from "./resolve-selection";
import { SaveController } from "./save-controller";
import { EMPTY_STATE, SessionStore } from "./session-store";
import type {
  AdoptOptions,
  DocumentChange,
  DocumentSource,
  LocalFileInput,
  MutationEffect,
  OpenOptions,
  OpenResult,
  SaveAsOptions,
  SaveResult,
  SessionApplyOptions,
  SessionError,
  SessionFiles,
  SessionMutateOptions,
  SessionSelection,
  SessionState,
} from "./types";

export const DEFAULT_AUTOSAVE_DELAY_MS = 1_000;

export interface DocumentSessionOptions {
  /** `window.MatrixOS.files`, or the part of it the session uses. */
  files: SessionFiles;
  /** Author of the revisions and comments the owner makes. */
  author: string;
  /** Recent documents list to keep up to date, if any. */
  recents?: RecentFilesStore | null;
  /** Downloads a document to the computer (a local document's Save, Download a copy). Default: a browser download. */
  download?: (name: string, bytes: Uint8Array) => void;
  /** Save edits after a pause. Default true. Local documents never autosave. */
  autosave?: boolean;
  autosaveDelayMs?: number;
  /** Most undo steps kept. Default 200. */
  undoLimit?: number;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

export class DocumentSession {
  private readonly files: SessionFiles;
  private readonly author: string;
  private readonly recents: RecentFilesStore | null;
  private readonly log: (message: string, error: unknown) => void;
  private readonly store: SessionStore;
  private readonly history: History;
  private readonly editor: EditController;
  private readonly saver: SaveController;

  private doc: DocxDocument | null = null;
  /** Identifies the active document; bumped whenever another one (or none) becomes active. */
  private documentToken = 0;
  /** Identifies the newest open, close or replace request; an older one that is still waiting gives way. */
  private loadToken = 0;
  private savedState = 0;
  private savedTracking = false;
  /** Grows with every change of the document and of Track changes, undo and redo included; never goes back. */
  private changeSeq = 0;
  private disposed = false;

  constructor(options: DocumentSessionOptions) {
    const now = options.now ?? (() => new Date());
    this.files = options.files;
    this.author = options.author;
    this.recents = options.recents ?? null;
    this.log = options.log ?? ((message, error) => console.warn(message, error));
    this.store = new SessionStore({ ...EMPTY_STATE, autosave: options.autosave ?? true }, this.log);
    this.history = new History(options.undoLimit ?? DEFAULT_UNDO_LIMIT);
    this.editor = new EditController(
      {
        requireDocument: () => this.requireDocument(),
        getDocument: () => this.doc,
        isTracking: () => this.store.state.tracking,
        author: this.author,
        now,
        log: this.log,
        syncTracking: () => this.syncTracking(),
        commit: (change) => this.commit(change),
      },
      this.history,
    );
    this.saver = new SaveController({
      files: this.files,
      download: options.download ?? ((name, bytes) => downloadBytes(name, bytes, DOCX_MIME)),
      delayMs: Math.max(0, options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS),
      now,
      log: this.log,
      host: {
        getState: () => this.store.state,
        getDocument: () => this.doc,
        getToken: () => this.documentToken,
        isDisposed: () => this.disposed,
        currentStateId: () => this.history.current,
        syncTracking: () => this.syncTracking(),
        patch: (partial) => this.store.patch(partial),
        markSaved: (stateId, tracking) => {
          this.savedState = stateId;
          this.savedTracking = tracking;
        },
        isDirty: () => this.isDirty(),
        pathBound: (path) => this.touchRecent(path),
      },
    });
  }

  // ---------------------------------------------------------------- state

  /** The current state. The object is replaced, never mutated. */
  getState = (): SessionState => this.store.state;

  /** Calls back after every state change. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  /** Calls back after every change of the active document's content. */
  onChange(listener: (change: DocumentChange) => void): () => void {
    return this.store.onChange(listener);
  }

  /** The engine handle of the active document, or null. Read from it freely; change it only through the session. */
  get document(): DocxDocument | null {
    return this.doc;
  }

  requireDocument(): DocxDocument {
    if (this.doc === null) throw new Error("no document is open");
    return this.doc;
  }

  /**
   * Names the content of the active document right now: every edit, undo and
   * redo moves it, and it is the same again only for the same content. Compare
   * it together with `documentKey` to tell whether the document changed.
   */
  editMark(): number {
    return this.history.current;
  }

  /**
   * Registers where the owner's selection is. The session carries it through
   * edits made by others (`DocumentChange.selection`) and stores it with undo
   * steps. Pass null to unregister.
   */
  setSelectionSource(source: (() => SessionSelection | null) | null): void {
    this.editor.setSelectionSource(source);
  }

  /** Stores the selection after the newest edit, so redo can restore it. */
  noteSelection(selection: SessionSelection | null): void {
    this.editor.noteSelection(selection);
  }

  // ---------------------------------------------------------------- open and close

  /** Reads and opens a document. Unsaved changes of the current one are saved first. */
  async open(path: string, options: OpenOptions = {}): Promise<OpenResult> {
    if (!isBridgePath(path)) return this.openFailed(sessionError("invalid_request"));
    const discarded = this.changeSeq;
    const token = await this.leaveCurrent(options);
    if (typeof token !== "number") return token;
    return this.load(() => this.files.read(path), { path, name: fileName(path), source: "matrix" }, options, token, discarded);
  }

  /**
   * Opens a file from the owner's computer as a local document: no path, no
   * autosave, no recent entry; Save downloads it under its name. Unsaved
   * changes of the current document are saved first, as for `open`.
   */
  async openLocal(file: LocalFileInput, options: OpenOptions = {}): Promise<OpenResult> {
    const discarded = this.changeSeq;
    const token = await this.leaveCurrent(options);
    if (typeof token !== "number") return token;
    return this.load(async () => ({ bytes: file.bytes, version: null }), { path: null, name: localFileName(file.name), source: "local" }, options, token, discarded);
  }

  /**
   * Reads the file again and replaces the local document with it, dropping the
   * unsaved changes made before the call. When more arrive while the file is
   * read, nothing is replaced: the result is the error `edited_meanwhile`.
   */
  async reload(): Promise<OpenResult> {
    const path = this.store.state.path;
    if (path === null) return { status: "error", error: sessionError("not_found") };
    return this.load(() => this.files.read(path), { path, name: fileName(path), source: "matrix" }, { discardChanges: true }, ++this.loadToken, this.changeSeq);
  }

  /** Starts an empty, unsaved document. */
  async createNew(options: { name?: string; discardChanges?: boolean } = {}): Promise<OpenResult> {
    const doc = createDocx({ author: this.author });
    return this.adopt(doc, { name: options.name ?? "Untitled", discardChanges: options.discardChanges, dirty: false });
  }

  /**
   * Makes an engine handle (for example a comparison result) the active,
   * unsaved document. It counts as changed until it is saved, unless
   * `dirty: false`.
   */
  async adopt(doc: DocxDocument, options: AdoptOptions & { dirty?: boolean }): Promise<OpenResult> {
    const token = await this.leaveCurrent(options);
    if (typeof token !== "number") return token;
    if (this.superseded(token)) return { status: "superseded" };
    this.activate(doc, { path: null, name: options.name, version: null, dirty: options.dirty ?? true, source: "matrix" });
    return { status: "opened", path: null };
  }

  /** Closes the document. Unsaved changes are saved first unless `discardChanges`. */
  async close(options: OpenOptions = {}): Promise<OpenResult> {
    const token = await this.leaveCurrent(options);
    if (typeof token !== "number") return token;
    if (this.superseded(token)) return { status: "superseded" };
    this.saver.cancel();
    this.documentToken++;
    this.doc = null;
    this.editor.reset();
    this.store.patch({ ...EMPTY_STATE, autosave: this.store.state.autosave, documentKey: this.documentToken });
    this.store.emit({ ...emptyChange("close", null), full: true });
    return { status: "opened", path: null };
  }

  /** Stops timers and listeners. The session cannot be used afterwards. */
  dispose(): void {
    this.disposed = true;
    this.loadToken++;
    this.documentToken++;
    this.saver.cancel();
    this.store.clear();
    this.editor.setSelectionSource(null);
  }

  // ---------------------------------------------------------------- editing

  /**
   * Applies engine operations to the document: tracked when the Track changes
   * toggle is on (or `options.track`), by the session author (or
   * `options.author`). One call is one undo step. Throws the engine's
   * `OfficeError` when an operation is invalid; the document is then unchanged.
   */
  apply(ops: readonly DocxOp[], options: SessionApplyOptions = {}): ApplyResult {
    return this.editor.apply(ops, options);
  }

  /**
   * Runs several `apply` or `mutate` calls as one undo step and one change
   * notification. When `fn` throws, the document returns to its state before
   * the batch and the error is rethrown.
   */
  batch<T>(fn: () => T, options: { origin?: string } = {}): T {
    return this.editor.batch(fn, options.origin ?? null);
  }

  /**
   * Changes the document through its handle in a way `apply` does not cover,
   * as one undo step. `effect` names the blocks that changed; without it
   * listeners refresh everything. Positions cannot follow such a change, so
   * the selection of the selection source is reported lost
   * (`DocumentChange.selectionLost`).
   */
  mutate<T>(fn: (doc: DocxDocument) => T, options: SessionMutateOptions & { effect?: (result: T) => MutationEffect | null } = {}): T {
    return this.editor.mutate(fn, options);
  }

  /** Accepts revisions as one undo step. Throws `stale_reference` for an unknown id. */
  acceptRevisions(ids: readonly RevisionId[] | "all", options: { origin?: string } = {}): ResolveRevisionsResult {
    return this.resolve((doc) => doc.acceptRevisions(ids), true, options.origin);
  }

  /** Rejects revisions as one undo step. */
  rejectRevisions(ids: readonly RevisionId[] | "all", options: { origin?: string } = {}): ResolveRevisionsResult {
    return this.resolve((doc) => doc.rejectRevisions(ids), false, options.origin);
  }

  /** Returns false when there is nothing to undo. */
  undo(): boolean {
    return this.editor.travel("undo");
  }

  redo(): boolean {
    return this.editor.travel("redo");
  }

  /** Ends the current undo step: the next edit starts a new one even when it has the same merge key. */
  sealUndoStep(): void {
    this.history.sealMerge();
  }

  /** Turns Track changes on or off. The setting is stored in the file with the next save. */
  setTracking(enabled: boolean): void {
    if (this.store.state.tracking === enabled) return;
    this.history.sealMerge();
    this.changeSeq++;
    this.store.patch({ tracking: enabled });
    this.syncTracking();
    this.store.patch({ dirty: this.isDirty() });
    this.saver.schedule();
  }

  // ---------------------------------------------------------------- saving

  /**
   * Writes the document to its path if it has unsaved changes. Also the way
   * to save now instead of waiting for autosave. A local document is
   * downloaded instead (`downloaded`) and is then clean.
   */
  save(): Promise<SaveResult> {
    if (this.store.state.source === "local" && this.doc !== null) return this.saver.download(true);
    return this.saver.save();
  }

  /** Downloads the document as it is now, under its name. Changes nothing in the session or the home. */
  downloadCopy(): Promise<SaveResult> {
    return this.saver.download(false);
  }

  /** Writes pending changes of a Matrix document (leaving the window, closing the app). Never downloads. */
  flush(): Promise<SaveResult> {
    return this.saver.save();
  }

  /** Writes the document to another path and continues there. */
  saveAs(path: string, options: SaveAsOptions = {}): Promise<SaveResult> {
    return this.saver.saveAs(path, options);
  }

  /**
   * Writes the document to a new file and continues there, leaving the
   * original file as it is. Without a path the copy is named after the
   * current file, for example `plan (copy).docx`.
   */
  saveCopy(path?: string): Promise<SaveResult> {
    return this.saver.saveCopy(path);
  }

  /** Resolves when every save requested so far has settled. */
  whenIdle(): Promise<void> {
    return this.saver.whenIdle();
  }

  setAutosave(enabled: boolean): void {
    if (this.store.state.autosave === enabled) return;
    this.store.patch({ autosave: enabled });
    if (enabled) this.saver.schedule();
    else this.saver.cancel();
  }

  // ---------------------------------------------------------------- internals

  /** Reads and activates a document. With `discardChanges` only changes up to `discarded` (the mark when the owner asked) are dropped. */
  private async load(
    read: () => Promise<{ bytes: Uint8Array; version: string | null }>,
    file: { path: string | null; name: string; source: DocumentSource },
    options: OpenOptions,
    token: number,
    discarded: number,
  ): Promise<OpenResult> {
    if (this.superseded(token)) return { status: "superseded" };
    this.store.patch({ status: "loading" });
    let doc: DocxDocument;
    let version: string | null;
    try {
      const content = await read();
      doc = await openDocx(content.bytes);
      version = content.version;
    } catch (error) {
      if (this.superseded(token)) return { status: "superseded" };
      this.log("docs: could not open the document", error);
      // The document that was open stays open.
      if (this.doc !== null) this.store.patch({ status: "ready" });
      return this.openFailed(toSessionError(error));
    }
    if (this.superseded(token)) return { status: "superseded" };
    if (this.doc !== null && options.discardChanges === true && this.changeSeq !== discarded) {
      // Edited after the owner chose to drop the changes: those edits were not part of that choice.
      this.store.patch({ status: "ready" });
      return { status: "error", error: sessionError("edited_meanwhile") };
    }
    if (this.doc !== null && this.isDirty() && options.discardChanges !== true) {
      // The current document was edited while the new one was being read.
      this.store.patch({ status: "ready" });
      return { status: "blocked", reason: "unsaved_changes" };
    }
    this.activate(doc, { ...file, version, dirty: false });
    return { status: "opened", path: file.path };
  }

  private openFailed(error: SessionError): OpenResult {
    if (this.doc === null) this.store.patch({ status: "error", error });
    return { status: "error", error };
  }

  /**
   * Saves or abandons the current document before another one takes its place.
   * A number means go ahead: it is the request's token, which the caller checks
   * with `superseded` after every wait. A request made while this one waited
   * for the save (another open, Home, a new document) supersedes it.
   */
  private async leaveCurrent(options: OpenOptions): Promise<OpenResult | number> {
    if (this.disposed) return { status: "superseded" };
    if (this.doc === null || options.discardChanges === true || !this.isDirty()) return ++this.loadToken;
    const state = this.store.state;
    if (state.conflict !== null) return { status: "blocked", reason: "conflict" };
    if (state.path === null) return { status: "blocked", reason: "unsaved_changes" };
    const token = ++this.loadToken;
    const documentKey = this.documentToken;
    const saved = await this.saver.save();
    // Another document (or none) took the place of the one this request saved.
    if (this.superseded(token) || documentKey !== this.documentToken) return { status: "superseded" };
    if (saved.status === "conflict") return { status: "blocked", reason: "conflict" };
    if (saved.status === "error") return { status: "blocked", reason: "save_failed" };
    return this.isDirty() ? { status: "blocked", reason: "unsaved_changes" } : token;
  }

  /**
   * True when a newer request was made since `token` was taken, or the session
   * was disposed. Every change of the active document (open, new, adopt,
   * close, dispose) is such a request, so the document is the one it was.
   */
  private superseded(token: number): boolean {
    return this.disposed || token !== this.loadToken;
  }

  private activate(doc: DocxDocument, file: { path: string | null; name: string; version: string | null; dirty: boolean; source: DocumentSource }): void {
    this.saver.cancel();
    this.documentToken++;
    this.doc = doc;
    this.editor.reset();
    const tracking = doc.getTrackRevisions();
    // An unsaved document counts as changed until it is written once.
    this.savedState = file.dirty ? -1 : this.history.current;
    this.savedTracking = tracking;
    this.store.patch({
      status: "ready",
      source: file.source,
      path: file.path,
      name: file.name,
      version: file.version,
      dirty: file.dirty,
      saveStatus: "idle",
      saveError: null,
      conflict: null,
      error: null,
      tracking,
      canUndo: false,
      canRedo: false,
      lastSavedAt: null,
      documentKey: this.documentToken,
      ...this.counts(),
    });
    this.store.emit({ ...emptyChange("load", null), full: true });
    if (file.path !== null) this.touchRecent(file.path);
  }

  private resolve(run: (doc: DocxDocument) => ResolveRevisionsResult, accept: boolean, origin: string | undefined): ResolveRevisionsResult {
    const doc = this.requireDocument();
    // Nothing to resolve: no undo step.
    if (doc.listRevisions().length === 0) return run(doc);
    return this.editor.mutate(run, {
      kind: "resolve",
      origin,
      effect: (result) => result,
      // Removed revision text moves the selection like any other edit.
      carrySelection: (selection) => trackSelectionThroughResolve(doc, selection, accept),
    });
  }

  /** Publishes the state after a content change, tells listeners, and arms autosave. */
  private commit(change: DocumentChange): void {
    this.changeSeq++;
    this.store.patch({ dirty: this.isDirty(), canUndo: this.history.canUndo, canRedo: this.history.canRedo, ...this.counts() });
    this.store.emit(change);
    this.saver.schedule();
  }

  private counts(): Pick<SessionState, "revisionCount" | "commentCount"> {
    const doc = this.doc;
    if (doc === null) return { revisionCount: 0, commentCount: 0 };
    return { revisionCount: doc.listRevisions().length, commentCount: doc.listComments().length };
  }

  private isDirty(): boolean {
    if (this.doc === null) return false;
    return this.history.current !== this.savedState || this.store.state.tracking !== this.savedTracking;
  }

  /** The Track changes toggle is session state; snapshots restore the file's flag, so it is written back. */
  private syncTracking(): void {
    const doc = this.doc;
    if (doc !== null && doc.getTrackRevisions() !== this.store.state.tracking) doc.setTrackRevisions(this.store.state.tracking);
  }

  private touchRecent(path: string): void {
    if (this.recents === null) return;
    // The store logs and swallows its own failures.
    void this.recents.touch({ path, name: fileName(path) });
  }
}
