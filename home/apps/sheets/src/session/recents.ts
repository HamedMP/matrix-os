/**
 * Recently opened files, kept in the app's `recent_files` table
 * (`matrix.json` `storage.tables`): one row per path with the time it was
 * last opened. The list is a convenience: every failure is logged and the
 * caller gets an empty or unchanged list, never an error.
 */

import { fileName } from "./file-io";
import type { SessionDb } from "./types";

export const RECENT_FILES_TABLE = "recent_files";
/** Most rows kept; older ones are deleted when a file is opened. */
export const MAX_RECENT_FILES = 20;
const QUERY_LIMIT = 100;

export interface RecentFile {
  path: string;
  name: string;
  /** ISO 8601 time the file was last opened. */
  openedAt: string;
}

interface StoredRow {
  id: string;
  path: string;
  name: string;
  openedAt: string;
}

function readRow(row: Record<string, unknown>): StoredRow | null {
  const { id, path, name } = row;
  const opened = row.opened_at;
  if (typeof id !== "string" || typeof path !== "string" || path === "") return null;
  const openedAt = typeof opened === "string" ? opened : opened instanceof Date ? opened.toISOString() : "";
  return { id, path, name: typeof name === "string" && name !== "" ? name : fileName(path), openedAt };
}

export interface RecentFiles {
  /** Newest first, one entry per path. */
  list(): Promise<RecentFile[]>;
  /** Records that a file was opened or saved under this path. */
  touch(path: string): Promise<void>;
  /** Forgets a path, for a file that no longer opens. */
  remove(path: string): Promise<void>;
}

export function createRecentFiles(
  db: SessionDb | null | undefined,
  options: { now?: () => number; log?: (message: string, error: unknown) => void } = {},
): RecentFiles {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);

  async function rows(): Promise<StoredRow[]> {
    if (db === null || db === undefined) return [];
    const found = await db.find(RECENT_FILES_TABLE, { orderBy: { opened_at: "desc" }, limit: QUERY_LIMIT });
    const out: StoredRow[] = [];
    for (const row of found) {
      const parsed = readRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out.sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0));
  }

  return {
    async list(): Promise<RecentFile[]> {
      try {
        const seen = new Set<string>();
        const out: RecentFile[] = [];
        for (const row of await rows()) {
          if (seen.has(row.path)) continue;
          seen.add(row.path);
          out.push({ path: row.path, name: row.name, openedAt: row.openedAt });
          if (out.length >= MAX_RECENT_FILES) break;
        }
        return out;
      } catch (error: unknown) {
        log("recent files could not be read", error);
        return [];
      }
    },

    async touch(path: string): Promise<void> {
      if (db === null || db === undefined) return;
      try {
        const openedAt = new Date(now()).toISOString();
        const all = await rows();
        const same = all.filter((row) => row.path === path);
        const first = same[0];
        if (first === undefined) await db.insert(RECENT_FILES_TABLE, { path, name: fileName(path), opened_at: openedAt });
        else await db.update(RECENT_FILES_TABLE, first.id, { path, name: fileName(path), opened_at: openedAt });
        // Rows for the same path beyond the first (two windows opened it at once) and rows past the cap go.
        const others = all.filter((row) => row.path !== path);
        const surplus = [...same.slice(1), ...others.slice(Math.max(0, MAX_RECENT_FILES - 1))];
        await Promise.all(surplus.map((row) => db.delete(RECENT_FILES_TABLE, row.id)));
      } catch (error: unknown) {
        log("recent files could not be updated", error);
      }
    },

    async remove(path: string): Promise<void> {
      if (db === null || db === undefined) return;
      try {
        const matching = (await rows()).filter((row) => row.path === path);
        await Promise.all(matching.map((row) => db.delete(RECENT_FILES_TABLE, row.id)));
      } catch (error: unknown) {
        log("recent files could not be updated", error);
      }
    },
  };
}
