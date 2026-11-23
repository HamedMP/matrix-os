/**
 * Docs document session.
 *
 * A `DocumentSession` owns one open `.docx`: the engine handle
 * (`DocxDocument`, the single source of truth), the undo history, the file
 * version and the Track changes toggle. Views never change the engine handle
 * directly; they call the session, which records an undo step, publishes the
 * new state and tells listeners which blocks to re-read.
 *
 * ```ts
 * const recents = new RecentFilesStore({ db: window.MatrixOS.db });
 * const session = new DocumentSession({ files: window.MatrixOS.files, author: "Rae Okafor", recents });
 *
 * await session.open("Documents/plan.docx");          // { status: "opened" | "blocked" | "error" | "superseded" }
 * const state = useSyncExternalStore(session.subscribe, session.getState);
 *
 * session.apply(ops);                                   // tracked or not, by the Track changes toggle
 * session.apply(agentOps, { track: true, author: "Matrix Agent", origin: "agent" });
 * session.acceptRevisions([revisionId]);               // also rejectRevisions, undo, redo, batch, mutate
 * session.setTracking(true);
 *
 * await session.save();                                 // { status: "saved" | "conflict" | "error" | "skipped" }
 * if (session.getState().conflict) {
 *   await session.reload();                             // take the file, drop local changes
 *   await session.saveCopy();                           // or keep local changes in "plan (copy).docx"
 * }
 * ```
 *
 * Guarantees:
 * - Dirty tracking follows the history: undoing back to the saved state is clean.
 * - Every write carries the version last read (`ifVersion`). On a conflict the
 *   local document is kept, autosave stops, and `state.conflict` is set until
 *   `reload()`, `saveCopy()` or `saveAs()` resolves it.
 * - Autosave is debounced and belongs to one document: a timer or a save that
 *   settles after another document was opened does nothing to the session.
 * - Opening another document saves the current one first; when that is not
 *   possible the open is `blocked` and nothing is lost. Pass
 *   `{ discardChanges: true }` to drop the changes.
 * - A file that cannot be read or parsed is never written.
 *
 * Documents from the owner's computer (`openLocal`) have `source: "local"`:
 * no path, no autosave and no recent entry; `save()` downloads them under
 * their name (`{ status: "downloaded" }`) and `saveAs(path)` turns them into
 * Matrix documents. `downloadCopy()` downloads any document as it is now.
 *
 * `session.document` is the engine handle for reading (view, revisions,
 * comments, outline). `session.onChange` reports content changes with the
 * block ids to refresh.
 */

export { DEFAULT_AUTOSAVE_DELAY_MS, DocumentSession } from "./document-session";
export type { DocumentSessionOptions } from "./document-session";
export { DEFAULT_UNDO_LIMIT, MERGE_WINDOW_MS } from "./history";
export { DOCX_EXTENSION, copyPath, directoryOf, downloadName, fileName, isBridgePath, localFileName } from "./paths";
export { DEFAULT_RECENT_LIMIT, RECENT_FILES_TABLE, RecentFilesStore } from "./recent-files";
export type { RecentFile, RecentFilesDb, RecentFilesOptions } from "./recent-files";
export { isBridgeFileError, sessionError, toSessionError } from "./errors";
export type {
  AdoptOptions,
  DocumentChange,
  DocumentChangeKind,
  DocumentSource,
  LocalFileInput,
  MutationEffect,
  OpenOptions,
  OpenResult,
  SaveAsOptions,
  SaveResult,
  SaveStatus,
  SessionApplyOptions,
  SessionConflict,
  SessionError,
  SessionErrorCode,
  SessionFiles,
  SessionMutateOptions,
  SessionSelection,
  SessionState,
  SessionStatus,
} from "./types";
