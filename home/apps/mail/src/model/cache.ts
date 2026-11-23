/**
 * The Mail app's local cache in `MatrixOS.db`, so the app paints at once and
 * refreshes in the background.
 *
 * Three tables, declared in `matrix.json` `storage.tables`:
 * - `mail_threads`: one row per thread summary (and its reply data), capped
 *   at `MAX_CACHED_THREADS`; the oldest by last message are evicted.
 * - `mail_folders`: one row per account with its folder list.
 * - `mail_snoozes`: local snoozes, one row per thread.
 *
 * Only summaries are cached, never message bodies. The cache is best effort:
 * every failure is logged by name and swallowed, because the provider is the
 * source of truth. Rows read back are validated and bad ones dropped.
 */
import type { MatrixOSDb, MatrixOSDbRow } from "../../../_shared/matrix-os";
import {
  MAIL_FOLDER_ROLES,
  isIsoInstant,
  type IsoInstant,
  type MailFolder,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";
import { defaultMailLogger, type MailLogger } from "./errors";
import { threadKey, type ThreadKey } from "./ids";
import type { CachedMail } from "./reducers";
import type { ReplyMeta } from "./types";

export const MAIL_CACHE_TABLES = Object.freeze({
  threads: "mail_threads",
  folders: "mail_folders",
  snoozes: "mail_snoozes",
});

export const MAX_CACHED_THREADS = 500;
export const MAX_CACHED_FOLDERS = 500;
export const MAX_CACHED_SNOOZES = 1000;
/** Rows per write request; keeps each request well under the 1 MB bridge limit. */
export const CACHE_WRITE_CHUNK = 100;
/** Rows deleted per eviction pass. */
export const CACHE_EVICT_BATCH = 100;

export type MailCacheDb = Pick<MatrixOSDb, "find" | "insert" | "update" | "bulkInsert" | "bulkUpdate" | "delete" | "count">;

export interface CachedThreadEntry {
  summary: ThreadSummary;
  replyMeta: ReplyMeta | null;
}

export interface CachedSnoozeEntry {
  accountId: string;
  /** Null removes the snooze. */
  until: IsoInstant | null;
}

export interface MailCache {
  load(accountIds: readonly string[]): Promise<CachedMail>;
  saveThreads(entries: readonly CachedThreadEntry[]): Promise<void>;
  saveFolders(accountId: string, folders: readonly MailFolder[]): Promise<void>;
  saveSnoozes(entries: Record<ThreadKey, CachedSnoozeEntry>): Promise<void>;
}

export function emptyCachedMail(): CachedMail {
  return { folders: {}, threads: [], replyMeta: {}, snoozes: {} };
}

/** A cache that stores nothing, for hosts without `MatrixOS.db`. */
export const noMailCache: MailCache = Object.freeze({
  load: async () => emptyCachedMail(),
  saveThreads: async () => undefined,
  saveFolders: async () => undefined,
  saveSnoozes: async () => undefined,
});

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isAddress(value: unknown): boolean {
  return isRecord(value) && isString(value.address) && (value.name === undefined || isString(value.name));
}

export function isThreadSummary(value: unknown): value is ThreadSummary {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.accountId) && isString(value.subject) && isString(value.snippet)
    && Array.isArray(value.participants) && value.participants.every(isAddress)
    && isIsoInstant(value.lastMessageAt) && typeof value.unread === "boolean" && typeof value.flagged === "boolean"
    && typeof value.hasAttachments === "boolean" && Array.isArray(value.folderIds) && value.folderIds.every(isString)
    && typeof value.messageCount === "number";
}

function isFolder(value: unknown): value is MailFolder {
  return isRecord(value) && isString(value.id) && isString(value.name)
    && (MAIL_FOLDER_ROLES as readonly unknown[]).includes(value.role)
    && (value.parentId === undefined || isString(value.parentId));
}

function isReplyMeta(value: unknown): value is ReplyMeta {
  return isRecord(value) && isString(value.lastFrom) && isIsoInstant(value.lastAt) && typeof value.ownerSentLast === "boolean";
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function lastAtMs(summary: ThreadSummary): number {
  const ms = Date.parse(summary.lastMessageAt);
  return Number.isFinite(ms) ? ms : 0;
}

export interface DbMailCacheOptions {
  maxThreads?: number;
  logger?: MailLogger;
}

export function createDbMailCache(db: MailCacheDb, options: DbMailCacheOptions = {}): MailCache {
  const maxThreads = options.maxThreads ?? MAX_CACHED_THREADS;
  const log = options.logger ?? defaultMailLogger;
  const T = MAIL_CACHE_TABLES;

  async function idsByColumn(table: string, column: string, values: string[]): Promise<Record<string, string>> {
    const rows = await db.find(table, { where: { [column]: { $in: values } }, limit: values.length });
    const ids: Record<string, string> = {};
    for (const row of rows) if (isString(row[column]) && isString(row.id)) ids[row[column] as string] = row.id as string;
    return ids;
  }

  /** Updates rows whose unique column already exists and inserts the rest. */
  async function upsert(table: string, column: string, rows: MatrixOSDbRow[]): Promise<void> {
    for (const chunk of chunks(rows, CACHE_WRITE_CHUNK)) {
      const ids = await idsByColumn(table, column, chunk.map((row) => row[column] as string));
      const updates = chunk.filter((row) => ids[row[column] as string]).map((row) => ({ id: ids[row[column] as string], data: row }));
      const inserts = chunk.filter((row) => !ids[row[column] as string]);
      if (updates.length) await db.bulkUpdate(table, updates);
      if (inserts.length) await db.bulkInsert(table, inserts);
    }
  }

  async function evictThreads(): Promise<void> {
    const total = await db.count(T.threads);
    const excess = Math.min(total - maxThreads, CACHE_EVICT_BATCH);
    if (excess <= 0) return;
    const oldest = await db.find(T.threads, { orderBy: { last_at: "asc" }, limit: excess });
    for (const row of oldest) if (isString(row.id)) await db.delete(T.threads, row.id);
  }

  async function guarded(event: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error: unknown) {
      log(event, error);
    }
  }

  return {
    async load(accountIds) {
      const result = emptyCachedMail();
      const ids = [...new Set(accountIds)].slice(0, 50);
      if (ids.length === 0) return result;
      const accounts = new Set(ids);
      const where = { account_id: { $in: ids } };
      const [threads, folders, snoozes] = await Promise.allSettled([
        db.find(T.threads, { where, orderBy: { last_at: "desc" }, limit: maxThreads }),
        db.find(T.folders, { where, limit: ids.length }),
        db.find(T.snoozes, { where, limit: MAX_CACHED_SNOOZES }),
      ]);
      if (threads.status === "fulfilled") {
        for (const row of threads.value) {
          const summary = json(row.summary);
          if (!isThreadSummary(summary) || !accounts.has(summary.accountId)) continue;
          result.threads.push(summary);
          const meta = json(row.reply_meta);
          if (isReplyMeta(meta)) result.replyMeta[threadKey(summary.accountId, summary.id)] = meta;
        }
      } else log("cache.load.threads", threads.reason);
      if (folders.status === "fulfilled") {
        for (const row of folders.value) {
          const list = json(row.folders);
          if (!isString(row.account_id) || !accounts.has(row.account_id) || !Array.isArray(list)) continue;
          result.folders[row.account_id] = list.filter(isFolder).slice(0, MAX_CACHED_FOLDERS);
        }
      } else log("cache.load.folders", folders.reason);
      if (snoozes.status === "fulfilled") {
        for (const row of snoozes.value) {
          if (isString(row.thread_key) && isString(row.account_id) && accounts.has(row.account_id) && isIsoInstant(row.wake_at)) {
            result.snoozes[row.thread_key] = row.wake_at;
          }
        }
      } else log("cache.load.snoozes", snoozes.reason);
      return result;
    },

    async saveThreads(entries) {
      const byKey: Record<ThreadKey, MatrixOSDbRow> = {};
      const newest = [...entries].sort((a, b) => lastAtMs(b.summary) - lastAtMs(a.summary)).slice(0, maxThreads);
      for (const { summary, replyMeta } of newest) {
        const key = threadKey(summary.accountId, summary.id);
        byKey[key] = { thread_key: key, account_id: summary.accountId, last_at: lastAtMs(summary), summary, reply_meta: replyMeta };
      }
      const rows = Object.values(byKey);
      if (rows.length === 0) return;
      await guarded("cache.save.threads", async () => {
        await upsert(T.threads, "thread_key", rows);
        await evictThreads();
      });
    },

    async saveFolders(accountId, folders) {
      const list = folders.slice(0, MAX_CACHED_FOLDERS).map((folder) => ({ ...folder }));
      await guarded("cache.save.folders", () => upsert(T.folders, "account_id", [{ account_id: accountId, folders: list }]));
    },

    async saveSnoozes(entries) {
      const set: MatrixOSDbRow[] = [];
      const cleared: string[] = [];
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.until === null) cleared.push(key);
        else set.push({ thread_key: key, account_id: entry.accountId, wake_at: entry.until });
      }
      await guarded("cache.save.snoozes", async () => {
        if (set.length) await upsert(T.snoozes, "thread_key", set);
        for (const chunk of chunks(cleared, CACHE_WRITE_CHUNK)) {
          const ids = await idsByColumn(T.snoozes, "thread_key", chunk);
          for (const id of Object.values(ids)) await db.delete(T.snoozes, id);
        }
      });
    },
  };
}
