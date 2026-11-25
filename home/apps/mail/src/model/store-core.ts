/**
 * The shared core of the Mail store: the state holder, the account and
 * provider registry, injected clock and timers, and the debounced cache
 * writer. The feature modules (lists, triage, drafts) receive this context.
 */
import type { MailAccount, MailProvider } from "../../../_shared/office-accounts/types/mail";
import { createDbMailCache, noMailCache, type MailCache, type MailCacheDb } from "./cache";
import { defaultMailLogger, type MailError, type MailLogger } from "./errors";
import type { ThreadKey } from "./ids";
import { MAX_THREADS_IN_MEMORY } from "./reducers";
import type { MailState } from "./types";

export interface MailAccountEntry {
  account: MailAccount;
  provider: MailProvider;
}

export interface MailTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MailStoreOptions {
  accounts: MailAccountEntry[];
  /** Defaults to a cache over `window.MatrixOS.db`, or none when the bridge has no db. */
  cache?: MailCache;
  now?: () => number;
  /** The owner's zone for dates in queries and quotes. Defaults to the runtime zone. */
  timeZone?: string;
  logger?: MailLogger;
  timers?: MailTimers;
  /** Threads per provider page, 1 to 50. */
  pageSize?: number;
  /** Quiet time after the last edit before a draft is saved. */
  autosaveMs?: number;
  /** Quiet time before changed summaries are written to the cache. */
  cacheFlushMs?: number;
  /** Mark a thread read when it is opened. Default true. */
  markReadOnOpen?: boolean;
}

export const DEFAULT_AUTOSAVE_MS = 1500;
export const DEFAULT_CACHE_FLUSH_MS = 2000;
export const MAX_LISTENERS = 100;

export interface StoreContext {
  get(): MailState;
  /** Applies an update; listeners run only when the state object changes. */
  set(update: (state: MailState) => MailState): void;
  subscribe(listener: () => void): () => void;
  entry(accountId: string): MailAccountEntry | undefined;
  entries(): MailAccountEntry[];
  setEntries(entries: MailAccountEntry[]): void;
  now(): number;
  timeZone: string;
  log: MailLogger;
  timers: MailTimers;
  cache: MailCache;
  pageSize: number;
  autosaveMs: number;
  markReadOnOpen: boolean;
  /** Queues summaries (and their reply data) for the next cache write. */
  markDirty(keys: readonly ThreadKey[]): void;
  /** Writes queued summaries now. */
  flushCache(): Promise<void>;
  /** Shows an error banner. */
  fail(error: MailError): void;
  isDisposed(): boolean;
  dispose(): void;
}

function runtimeTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (error: unknown) {
    if (error instanceof RangeError) return "UTC";
    throw error;
  }
}

/** The cache over the bridge database when the host provides one. */
export function defaultMailCache(logger?: MailLogger): MailCache {
  if (typeof window === "undefined") return noMailCache;
  const db = (window as unknown as { MatrixOS?: { db?: MailCacheDb } }).MatrixOS?.db;
  return db ? createDbMailCache(db, { logger }) : noMailCache;
}

const globalTimers: MailTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createStoreContext(initial: MailState, options: MailStoreOptions): StoreContext {
  let state = initial;
  let disposed = false;
  let entries = [...options.accounts];
  const listeners: Array<() => void> = [];
  const log = options.logger ?? defaultMailLogger;
  const timers = options.timers ?? globalTimers;
  const cache = options.cache ?? defaultMailCache(log);
  const flushMs = options.cacheFlushMs ?? DEFAULT_CACHE_FLUSH_MS;
  let dirty: Record<ThreadKey, true> = {};
  let dirtyCount = 0;
  let flushTimer: unknown = null;

  const ctx: StoreContext = {
    get: () => state,
    set(update) {
      if (disposed) return;
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      if (listeners.length >= MAX_LISTENERS) throw new RangeError("Too many Mail store listeners");
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    entry: (accountId) => entries.find((entry) => entry.account.id === accountId),
    entries: () => entries,
    setEntries(next) {
      entries = [...next];
    },
    now: options.now ?? (() => Date.now()),
    timeZone: options.timeZone ?? runtimeTimeZone(),
    log,
    timers,
    cache,
    pageSize: Math.min(50, Math.max(1, Math.floor(options.pageSize ?? 25))),
    autosaveMs: options.autosaveMs ?? DEFAULT_AUTOSAVE_MS,
    markReadOnOpen: options.markReadOnOpen ?? true,
    markDirty(keys) {
      if (disposed) return;
      for (const key of keys) {
        if (!dirty[key]) dirtyCount += 1;
        dirty[key] = true;
      }
      if (dirtyCount >= MAX_THREADS_IN_MEMORY) {
        void ctx.flushCache();
        return;
      }
      if (flushTimer === null && dirtyCount > 0) {
        flushTimer = timers.setTimeout(() => {
          flushTimer = null;
          void ctx.flushCache();
        }, flushMs);
      }
    },
    async flushCache() {
      if (flushTimer !== null) {
        timers.clearTimeout(flushTimer);
        flushTimer = null;
      }
      const keys = Object.keys(dirty);
      dirty = {};
      dirtyCount = 0;
      const rows = keys
        .filter((key) => state.threads[key])
        .map((key) => ({ summary: state.threads[key], replyMeta: state.replyMeta[key] ?? null }));
      if (rows.length) await cache.saveThreads(rows);
    },
    fail(error) {
      ctx.set((s) => ({ ...s, error }));
    },
    isDisposed: () => disposed,
    dispose() {
      if (flushTimer !== null) timers.clearTimeout(flushTimer);
      flushTimer = null;
      disposed = true;
      listeners.length = 0;
    },
  };
  return ctx;
}
