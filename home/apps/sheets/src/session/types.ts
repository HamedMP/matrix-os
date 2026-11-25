/** Types shared by the session modules. Plain data and small interfaces only. */

import type { CellRange, ChangedCell, SheetId, SheetRangeRef } from "./engine";

/** What a file is saved as. Decided by the extension of its path. */
export type SheetFileFormat = "xlsx" | "csv" | "tsv";

/**
 * Where the open document lives: `matrix` for a file in the owner's home (or
 * a new workbook that will be saved there), `local` for a file opened from
 * this computer, which is saved by downloading it again until a copy is
 * saved to Matrix.
 */
export type DocumentSource = "matrix" | "local";

/** The part of `window.MatrixOS.files` the session uses. */
export interface SessionFiles {
  read(path: string): Promise<{ path: string; bytes: Uint8Array; size: number; version: string; mimeType: string }>;
  write(
    path: string,
    bytes: Uint8Array,
    options: { ifVersion: string | null; createParents?: boolean },
  ): Promise<{ path: string; version: string; size: number; modifiedAt: string }>;
}

/** The part of `window.MatrixOS.db` the recent-files list uses: each of its changes is one of these statements. */
export interface SessionDb {
  find(
    table: string,
    options?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number },
  ): Promise<Array<Record<string, unknown>>>;
  /** Inserts rows; a row that collides with a unique index is skipped (ON CONFLICT DO NOTHING). */
  bulkInsert(table: string, rows: Array<Record<string, unknown>>): Promise<{ ids: string[] }>;
  /** Updates the row only while its stored `payload` still equals `expectedPayload`. */
  compareAndSwap(table: string, id: string, expectedPayload: Record<string, unknown>, data: Record<string, unknown>): Promise<{ ok: boolean }>;
}

/** Timers, replaceable in tests. */
export interface SessionTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SessionDeps {
  files: SessionFiles;
  /** Recent files are kept here; without it the list stays empty. */
  db?: SessionDb | null;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?: () => number;
  timers?: SessionTimers;
  /** Quiet time after the last edit before an automatic save. Default 1500 ms. */
  autosaveDelayMs?: number;
  /** Receives failures for the console; never shown to the owner. */
  log?: (message: string, error: unknown) => void;
}

/** Client-safe reason a session operation failed. */
export type SessionErrorCode =
  /** The file does not exist. */
  | "not_found"
  /** The app may not read or write this path. */
  | "forbidden"
  /** Larger than the 10 MiB file limit, or more cells than the engine opens. */
  | "too_large"
  /** Not a spreadsheet this app reads (encrypted, another format, macro sheet). */
  | "unsupported"
  /** A damaged file. */
  | "corrupt"
  /** The bridge or the gateway failed; trying again may work. */
  | "unavailable"
  /** A path that is not a `.xlsx`, `.csv` or `.tsv` file path. */
  | "invalid_path"
  /** A file already exists at the path a copy was to be saved to. */
  | "exists"
  /** A formula that does not parse. */
  | "formula"
  /** The edit is not allowed here (part of an array formula, pending changes on the sheet). */
  | "not_allowed"
  /** The edit touches more cells than one step may. */
  | "too_many_cells"
  /** A CSV or TSV file cannot hold assistant changes that wait for review. */
  | "review_pending"
  /** Anything else. */
  | "failed";

export interface SessionFailure {
  ok: false;
  code: SessionErrorCode;
  /** One sentence for the owner. */
  message: string;
}

export type EditResult = { ok: true } | SessionFailure;

export type SaveOutcome =
  | { status: "saved"; path: string }
  /** Nothing to write. */
  | { status: "unchanged" }
  /** The file changed on disk since it was read. Local edits are kept. */
  | { status: "conflict" }
  /** The session was closed or reloaded before the save settled. */
  | { status: "superseded" }
  | { status: "error"; code: SessionErrorCode; message: string };

export type SaveState = "idle" | "pending" | "saving" | "saved" | "conflict" | "error";

/** A snapshot of the session for the user interface. Replaced, never mutated. */
export interface SessionState {
  /** Grows with every change of workbook content, layout or sheets. */
  revision: number;
  /** Home-relative path, or null for a workbook that was never saved. */
  path: string | null;
  /** File name without directories. */
  name: string;
  source: DocumentSource;
  format: SheetFileFormat;
  /** True when edits are not on disk yet. */
  dirty: boolean;
  saveState: SaveState;
  /** Set with `saveState: "error"`. */
  saveError: { code: SessionErrorCode; message: string } | null;
  /** Milliseconds since the epoch of the last successful save, or null. */
  lastSavedAt: number | null;
  autosave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** What undo would take back, for a menu label. */
  undoLabel: string | null;
  redoLabel: string | null;
  activeSheetId: SheetId;
  /** False when the last calculation stopped at a bound; some values are then out of date. */
  calcComplete: boolean;
  /** True when the format keeps values of the first sheet only (CSV and TSV). */
  valuesOnlyFormat: boolean;
}

export type SessionChangeCause = "edit" | "undo" | "redo" | "load" | "external" | "layout";

export type SessionEvent =
  /** Workbook content, layout or the sheet list changed. */
  | {
      type: "change";
      cause: SessionChangeCause;
      /** Cells whose value changed in the calculation that followed. */
      recalculated: ChangedCell[];
      /** The area an undo or redo touched, to bring into view. */
      affected: SheetRangeRef | null;
    }
  /** Only `getState()` changed (saving, dirty, active sheet). */
  | { type: "state" };

export type SessionListener = (event: SessionEvent) => void;

export interface SortKey {
  /** Column of the sheet. */
  col: number;
  descending?: boolean;
}

export type { CellRange };
