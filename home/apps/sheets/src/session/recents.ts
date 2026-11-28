/**
 * Recently opened files, kept in the app's `recent_files` table
 * (`matrix.json` `storage.tables`).
 *
 * The whole list is one row whose `payload` holds the entries, newest first.
 * Every change is therefore a single database statement: the row is created
 * with `bulkInsert` (ON CONFLICT DO NOTHING on the unique `slot`), and later
 * changes use `compareAndSwap` against the payload that was read. When another
 * window changed the list in between, the change is reapplied to the newer
 * list, so neither window's entry is lost and no partial update is stored.
 *
 * The list is a convenience: every failure is logged and the caller gets an
 * empty or unchanged list, never an error.
 */

import { fileName, isValidFilePath } from "./file-io";
import type { SessionDb } from "./types";

export const RECENT_FILES_TABLE = "recent_files";
/** Most entries kept; older ones are dropped when a file is opened. */
export const MAX_RECENT_FILES = 20;
/** Most stored entries read back, for a row another version of the app wrote longer. */
const MAX_STORED_ENTRIES = 100;
const MAX_NAME_LENGTH = 255;
/** The `slot` of the one row that holds the list. */
const LIST_SLOT = "recent";
/** Attempts before a change that keeps losing to other windows is given up and logged. */
const MAX_WRITE_ATTEMPTS = 5;

export interface RecentFile {
  path: string;
  name: string;
  /** ISO 8601 time the file was last opened. */
  openedAt: string;
}

export interface RecentFiles {
  /** Newest first, one entry per path. */
  list(): Promise<RecentFile[]>;
  /** Records that a file was opened or saved under this path. */
  touch(path: string): Promise<void>;
  /** Forgets a path, for a file that no longer opens. */
  remove(path: string): Promise<void>;
}

type Payload = Record<string, unknown>;

interface StoredList {
  id: string;
  /** The payload exactly as read, for the compare-and-swap. */
  payload: Payload;
  entries: RecentFile[];
}

function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(value: unknown): RecentFile | null {
  if (!isRecord(value)) return null;
  const { path, name, openedAt } = value;
  if (typeof path !== "string" || !isValidFilePath(path) || typeof name !== "string" || typeof openedAt !== "string") return null;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || Number.isNaN(Date.parse(openedAt))) return null;
  return { path, name, openedAt };
}

/** The readable entries, in stored order, one per path. */
function readEntries(payload: Payload): RecentFile[] {
  const stored = Array.isArray(payload.entries) ? payload.entries : [];
  const seen = new Set<string>();
  const entries: RecentFile[] = [];
  for (const value of stored.slice(0, MAX_STORED_ENTRIES)) {
    const entry = readEntry(value);
    if (entry === null || seen.has(entry.path)) continue;
    seen.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

export function createRecentFiles(
  db: SessionDb | null | undefined,
  options: { now?: () => number; log?: (message: string, error: unknown) => void } = {},
): RecentFiles {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  /** Changes from this list run one after another, so they do not race each other. */
  let queue: Promise<void> = Promise.resolve();

  async function read(store: SessionDb): Promise<StoredList | null> {
    const [row] = await store.find(RECENT_FILES_TABLE, { where: { slot: LIST_SLOT }, limit: 1 });
    if (row === undefined) return null;
    if (typeof row.id !== "string" || !isRecord(row.payload)) throw new Error("the recent files row cannot be read");
    return { id: row.id, payload: row.payload, entries: readEntries(row.payload) };
  }

  /**
   * Applies `next` to the stored list in one statement. `next` returns null
   * when nothing changes. A lost race rereads the list and applies `next` again.
   */
  async function change(store: SessionDb, next: (entries: RecentFile[]) => RecentFile[] | null): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const stored = await read(store);
      const entries = next(stored?.entries ?? []);
      if (entries === null) return;
      const payload = { entries };
      if (stored === null) {
        const { ids } = await store.bulkInsert(RECENT_FILES_TABLE, [{ slot: LIST_SLOT, payload }]);
        if (ids.length > 0) return;
      } else {
        const { ok } = await store.compareAndSwap(RECENT_FILES_TABLE, stored.id, stored.payload, { payload });
        if (ok) return;
      }
    }
    throw new Error("the recent files list kept changing in another window");
  }

  function enqueue(next: (entries: RecentFile[]) => RecentFile[] | null): Promise<void> {
    if (db === null || db === undefined) return Promise.resolve();
    const store = db;
    const run = queue
      .then(() => change(store, next))
      .catch((error: unknown) => {
        log("recent files could not be updated", error);
      });
    queue = run;
    return run;
  }

  return {
    async list(): Promise<RecentFile[]> {
      if (db === null || db === undefined) return [];
      try {
        const stored = await read(db);
        return stored === null ? [] : stored.entries.slice(0, MAX_RECENT_FILES);
      } catch (error: unknown) {
        log("recent files could not be read", error);
        return [];
      }
    },

    touch(path: string): Promise<void> {
      if (!isValidFilePath(path)) return Promise.resolve();
      return enqueue((entries) => {
        const entry: RecentFile = { path, name: fileName(path).slice(0, MAX_NAME_LENGTH), openedAt: new Date(now()).toISOString() };
        return [entry, ...entries.filter((other) => other.path !== path)].slice(0, MAX_RECENT_FILES);
      });
    },

    remove(path: string): Promise<void> {
      return enqueue((entries) => {
        const left = entries.filter((entry) => entry.path !== path);
        return left.length === entries.length ? null : left;
      });
    },
  };
}
