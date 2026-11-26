/**
 * Types of the Docs document session. See `./index.ts` for the overview.
 */

import type { MatrixOSFiles } from "../../../_shared/matrix-os";
import type {
  ApplyResult,
  BlockId,
  DocxDocument,
  RevisionId,
  StoryId,
  TextPosition,
} from "../../../_shared/office-engine/index";

/** The part of `window.MatrixOS.files` the session uses. */
export type SessionFiles = Pick<MatrixOSFiles, "read" | "write" | "stat">;

export type SessionStatus =
  /** No document. */
  | "empty"
  /** A document is being read; the previous one, if any, is still shown. */
  | "loading"
  | "ready"
  /** The last open failed and there is no document. */
  | "error";

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

/** Client-safe reason. Detail from the bridge or the engine is logged, never shown. */
export type SessionErrorCode =
  | "not_found"
  | "forbidden"
  | "too_large"
  | "unavailable"
  | "invalid_request"
  | "version_conflict"
  | "already_exists"
  /** Not a word-processing document this engine reads. */
  | "unsupported_file"
  /** A document that is damaged. */
  | "corrupt_file"
  /** The open document was edited while its replacement was read: it was kept, not replaced. */
  | "edited_meanwhile"
  | "unknown";

export interface SessionError {
  code: SessionErrorCode;
  /** A fixed sentence for the owner; safe to display. */
  message: string;
}

/** The file changed on disk since this session read it. The local document is kept. */
export interface SessionConflict {
  path: string;
  /** ISO 8601 time the conflict was found. */
  detectedAt: string;
}

/** A selection as the session carries it: two positions, `focus` is the moving end. */
export interface SessionSelection {
  anchor: TextPosition;
  focus: TextPosition;
}

/**
 * Where the active document lives and where Save sends it.
 * - `matrix`: a file in the owner's home (or a new document that will be saved there).
 * - `local`: a file opened from the owner's computer. It has no path, never
 *   autosaves, and Save downloads it under its own name. Saving it to the
 *   home (`saveAs`) makes it a `matrix` document.
 */
export type DocumentSource = "matrix" | "local";

/** A file read from the owner's computer. */
export interface LocalFileInput {
  name: string;
  bytes: Uint8Array;
}

/** Immutable. A new object is published on every change, so it works with `useSyncExternalStore`. */
export interface SessionState {
  status: SessionStatus;
  source: DocumentSource;
  /** Home-relative path, or null for a document that was never saved or came from the computer. */
  path: string | null;
  /** File name, or the working name of an unsaved document. */
  name: string;
  /** Opaque version of the file as last read or written. */
  version: string | null;
  /** True when the document differs from what was last read or written. */
  dirty: boolean;
  saveStatus: SaveStatus;
  /** Why the last save failed (`saveStatus: "error"`). */
  saveError: SessionError | null;
  conflict: SessionConflict | null;
  /** Why the last open failed (`status: "error"`). */
  error: SessionError | null;
  /** The Track changes toggle. New edits are recorded as revisions while it is on. */
  tracking: boolean;
  autosave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  revisionCount: number;
  commentCount: number;
  /** ISO 8601 time of the last successful write. */
  lastSavedAt: string | null;
  /** Changes whenever another document becomes the active one. */
  documentKey: number;
}

export type DocumentChangeKind =
  /** Another document became active (or none: `close`). */
  | "load"
  | "close"
  | "edit"
  | "undo"
  | "redo"
  /** Revisions were accepted or rejected. */
  | "resolve";

/** What changed in the active document. Listeners re-read the named blocks from the engine. */
export interface DocumentChange {
  kind: DocumentChangeKind;
  /** True when anything may have changed: re-read the whole view. The id lists are then empty. */
  full: boolean;
  changedBlockIds: BlockId[];
  createdBlockIds: BlockId[];
  removedBlockIds: BlockId[];
  changedStoryIds: StoryId[];
  /** Revisions the change created or extended. */
  revisionIds: RevisionId[];
  /** The `origin` given by the caller, for example `editor`, `agent` or `review`. */
  origin: string | null;
  /**
   * Where the selection of the selection source belongs after the change:
   * carried through an edit, or the stored selection of an undo or redo step.
   * Null when unknown.
   */
  selection: SessionSelection | null;
  /**
   * True when the selection source had a selection that could not be carried
   * through the change: its text is gone, or a custom mutation changed the
   * document in a way positions cannot follow. Listeners drop that selection
   * rather than keep its old offsets.
   */
  selectionLost: boolean;
}

export interface SessionApplyOptions {
  /** Default: the Track changes toggle. */
  track?: boolean;
  /** Default: the session author. */
  author?: string;
  /** Positions to carry through the edit; returned in `ApplyResult.positions`. */
  positions?: TextPosition[];
  /** Free-form tag reported in `DocumentChange.origin`. */
  origin?: string;
  /**
   * Calls with the same key that follow each other closely share one undo
   * step (typing a word). Ignored inside `batch`.
   */
  mergeKey?: string;
}

export interface SessionMutateOptions {
  origin?: string;
  kind?: DocumentChangeKind;
}

/** What a custom mutation reports so listeners can refresh less than everything. */
export interface MutationEffect {
  changedBlockIds?: BlockId[];
  createdBlockIds?: BlockId[];
  removedBlockIds?: BlockId[];
  changedStoryIds?: StoryId[];
  revisionIds?: RevisionId[];
}

export type OpenResult =
  | { status: "opened"; path: string | null }
  /** The current document has changes that could not be saved; nothing was opened. */
  | { status: "blocked"; reason: "unsaved_changes" | "conflict" | "save_failed" }
  | { status: "error"; error: SessionError }
  /** A later open, close or dispose won. */
  | { status: "superseded" };

export type SaveResult =
  | { status: "saved"; path: string; version: string }
  /** The document was handed to the browser as a download (a local document's Save, or Download a copy). */
  | { status: "downloaded"; name: string }
  | { status: "conflict"; path: string }
  | { status: "error"; error: SessionError }
  | { status: "skipped"; reason: "no_document" | "no_path" | "clean" | "not_active" };

export interface OpenOptions {
  /** Drop unsaved changes of the current document instead of saving them first. */
  discardChanges?: boolean;
}

export interface SaveAsOptions {
  /** Replace an existing file at the path. Default false: an existing file is `already_exists`. */
  overwrite?: boolean;
}

export interface AdoptOptions extends OpenOptions {
  /** Working name shown until the document is saved. */
  name: string;
}

export type { ApplyResult, DocxDocument };
