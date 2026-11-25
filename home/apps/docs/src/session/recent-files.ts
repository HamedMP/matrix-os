/**
 * The list of recently opened documents, kept in the app's table
 * `recent_documents` (declared in matrix.json `storage.tables`).
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

export interface RecentFile {
  path: string;
  name: string;
  /** ISO 8601 time the document was last opened or saved under this path. */
  openedAt: string;
}

export type RecentFilesDb = Pick<MatrixOSDb, "find" | "insert" | "update" | "delete">;

export interface RecentFilesOptions {
  db: RecentFilesDb;
  /** Most entries kept; older ones are deleted. Default 20, at most 100. */
  limit?: number;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

function readRow(row: MatrixOSDbRow): (RecentFile & { id: string }) | null {
  const { id, path, name, opened_at: openedAt } = row;
  if (typeof id !== "string" || !isBridgePath(path) || typeof name !== "string" || typeof openedAt !== "string") return null;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || Number.isNaN(Date.parse(openedAt))) return null;
  return { id, path, name, openedAt };
}

export class RecentFilesStore {
  private readonly db: RecentFilesDb;
  private readonly limit: number;
  private readonly now: () => Date;
  private readonly log: (message: string, error: unknown) => void;
  /** Writes run one after another so two touches cannot both insert the same path. */
  private queue: Promise<void> = Promise.resolve();
  private lastStamp = 0;

  constructor(options: RecentFilesOptions) {
    this.db = options.db;
    this.limit = Math.min(MAX_RECENT_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_RECENT_LIMIT)));
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message, error) => console.warn(message, error));
  }

  /** Newest first, one entry per path. Empty when the store cannot be read. */
  async list(): Promise<RecentFile[]> {
    try {
      const rows = await this.readAll();
      const seen = new Set<string>();
      const entries: RecentFile[] = [];
      for (const { path, name, openedAt } of rows) {
        if (seen.has(path)) continue;
        seen.add(path);
        entries.push({ path, name, openedAt });
        if (entries.length === this.limit) break;
      }
      return entries;
    } catch (error) {
      this.log("docs: could not read recent documents", error);
      return [];
    }
  }

  /** Puts a document at the top of the list. */
  touch(file: { path: string; name: string }): Promise<void> {
    return this.enqueue(async () => {
      if (!isBridgePath(file.path)) return;
      const name = file.name.slice(0, MAX_NAME_LENGTH) || file.path;
      const rows = await this.readAll();
      const openedAt = this.stamp();
      const [existing, ...duplicates] = rows.filter((row) => row.path === file.path);
      if (existing === undefined) await this.db.insert(RECENT_FILES_TABLE, { path: file.path, name, opened_at: openedAt });
      else await this.db.update(RECENT_FILES_TABLE, existing.id, { name, opened_at: openedAt });
      const others = rows.filter((row) => row.path !== file.path);
      const stale = [...duplicates, ...others.slice(Math.max(0, this.limit - 1))];
      await Promise.all(stale.map((row) => this.db.delete(RECENT_FILES_TABLE, row.id)));
    }, "docs: could not update recent documents");
  }

  remove(path: string): Promise<void> {
    return this.enqueue(async () => {
      const rows = (await this.readAll()).filter((row) => row.path === path);
      await Promise.all(rows.map((row) => this.db.delete(RECENT_FILES_TABLE, row.id)));
    }, "docs: could not update recent documents");
  }

  private async readAll(): Promise<Array<RecentFile & { id: string }>> {
    const rows = await this.db.find(RECENT_FILES_TABLE, { orderBy: { opened_at: "desc" }, limit: MAX_RECENT_LIMIT * 2 });
    const entries: Array<RecentFile & { id: string }> = [];
    for (const row of rows) {
      const entry = readRow(row);
      if (entry !== null) entries.push(entry);
    }
    return entries.sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
  }

  /** Strictly increasing, so entries touched within one millisecond keep their order. */
  private stamp(): string {
    this.lastStamp = Math.max(this.now().getTime(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  private enqueue(task: () => Promise<void>, message: string): Promise<void> {
    const run = this.queue.then(task).catch((error: unknown) => {
      this.log(message, error);
    });
    this.queue = run;
    return run;
  }
}
