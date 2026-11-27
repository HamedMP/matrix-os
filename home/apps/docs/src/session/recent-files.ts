/**
 * The list of recently opened documents, kept in the app's table
 * `recent_documents` (declared in matrix.json `storage.tables`).
 *
 * The whole list is one row whose `payload` holds the entries, newest first.
 * Every change is therefore a single database statement: the row is created
 * with `bulkInsert` (ON CONFLICT DO NOTHING on the unique `slot`), and later
 * changes use `compareAndSwap` against the payload that was read. When another
 * window changed the list in between, the change is reapplied to the newer
 * list, so neither window's entry is lost and no partial update is stored.
 *
 * The list is a convenience: every failure is logged and swallowed into an
 * empty or unchanged list, so it can never stop a document from opening.
 */

import type { MatrixOSDb, MatrixOSDbRow } from "../../../_shared/matrix-os";
import { isBridgePath } from "./paths";

export const RECENT_FILES_TABLE = "recent_documents";
export const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;
const MAX_NAME_LENGTH = 255;
/** The `slot` of the one row that holds the list. */
const LIST_SLOT = "recent";
/** Attempts before a change that keeps losing to other windows is given up and logged. */
const MAX_WRITE_ATTEMPTS = 5;

export interface RecentFile {
  path: string;
  name: string;
  /** ISO 8601 time the document was last opened or saved under this path. */
  openedAt: string;
}

export type RecentFilesDb = Pick<MatrixOSDb, "find" | "bulkInsert" | "compareAndSwap">;

export interface RecentFilesOptions {
  db: RecentFilesDb;
  /** Most entries kept; older ones are dropped. Default 20, at most 100. */
  limit?: number;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

interface StoredList {
  id: string;
  /** The payload exactly as read, for the compare-and-swap. */
  payload: MatrixOSDbRow;
  entries: RecentFile[];
}

function isRecord(value: unknown): value is MatrixOSDbRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(value: unknown): RecentFile | null {
  if (!isRecord(value)) return null;
  const { path, name, openedAt } = value;
  if (!isBridgePath(path) || typeof name !== "string" || typeof openedAt !== "string") return null;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || Number.isNaN(Date.parse(openedAt))) return null;
  return { path, name, openedAt };
}

/** The readable entries, in stored order, one per path. */
function readEntries(payload: MatrixOSDbRow): RecentFile[] {
  const stored = Array.isArray(payload.entries) ? payload.entries : [];
  const seen = new Set<string>();
  const entries: RecentFile[] = [];
  for (const value of stored.slice(0, MAX_RECENT_LIMIT * 2)) {
    const entry = readEntry(value);
    if (entry === null || seen.has(entry.path)) continue;
    seen.add(entry.path);
    entries.push(entry);
  }
  return entries;
}

export class RecentFilesStore {
  private readonly db: RecentFilesDb;
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly log: (message: string, error: unknown) => void;
  /** Changes from this window run one after another, so they do not race each other. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RecentFilesOptions) {
    this.db = options.db;
    this.limit = Math.min(MAX_RECENT_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_RECENT_LIMIT)));
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message, error) => console.warn(message, error));
  }

  /** Newest first, one entry per path. Empty when the store cannot be read. */
  async list(): Promise<RecentFile[]> {
    try {
      const stored = await this.read();
      return stored === null ? [] : stored.entries.slice(0, this.limit);
    } catch (error) {
      this.log("docs: could not read recent documents", error);
      return [];
    }
  }

  /** Puts a document at the top of the list. */
  touch(file: { path: string; name: string }): Promise<void> {
    if (!isBridgePath(file.path)) return Promise.resolve();
    const name = file.name.slice(0, MAX_NAME_LENGTH) || file.path;
    return this.enqueue(
      () =>
        this.change((entries) => {
          const entry: RecentFile = { path: file.path, name, openedAt: this.now().toISOString() };
          return [entry, ...entries.filter((other) => other.path !== file.path)].slice(0, this.limit);
        }),
      "docs: could not update recent documents",
    );
  }

  remove(path: string): Promise<void> {
    return this.enqueue(
      () =>
        this.change((entries) => {
          const left = entries.filter((entry) => entry.path !== path);
          return left.length === entries.length ? null : left;
        }),
      "docs: could not update recent documents",
    );
  }

  private async read(): Promise<StoredList | null> {
    const [row] = await this.db.find(RECENT_FILES_TABLE, { where: { slot: LIST_SLOT }, limit: 1 });
    if (row === undefined) return null;
    if (typeof row.id !== "string" || !isRecord(row.payload)) throw new Error("the recent documents row cannot be read");
    return { id: row.id, payload: row.payload, entries: readEntries(row.payload) };
  }

  /**
   * Applies `next` to the stored list in one statement. `next` returns null
   * when nothing changes. A lost race rereads the list and applies `next` again.
   */
  private async change(next: (entries: RecentFile[]) => RecentFile[] | null): Promise<void> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const stored = await this.read();
      const entries = next(stored?.entries ?? []);
      if (entries === null) return;
      const payload = { entries };
      if (stored === null) {
        const { ids } = await this.db.bulkInsert(RECENT_FILES_TABLE, [{ slot: LIST_SLOT, payload }]);
        if (ids.length > 0) return;
      } else {
        const { ok } = await this.db.compareAndSwap(RECENT_FILES_TABLE, stored.id, stored.payload, { payload });
        if (ok) return;
      }
    }
    throw new Error("the recent documents list kept changing in another window");
  }

  private enqueue(task: () => Promise<void>, message: string): Promise<void> {
    const run = this.queue.then(task).catch((error: unknown) => {
      this.log(message, error);
    });
    this.queue = run;
    return run;
  }
}
