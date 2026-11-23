/**
 * Folders, thread lists, paging, search and the open thread.
 *
 * Every provider reply is checked against a per-list request number, so a
 * slow answer for a list the owner has since refreshed is dropped. Cached
 * rows stay visible while a refresh runs and when it fails.
 */
import type { MailThread, Page, ThreadSummary } from "../../../_shared/office-accounts/types/mail";
import { LruCache } from "../../../_shared/office-accounts/mail/support";
import { localMailError, toMailError, type MailError } from "./errors";
import { UNIFIED_INBOX, viewKeyOf, type ThreadKey, type ViewDescriptor, type ViewKey } from "./ids";
import { MAX_QUERY_CHARS, isEmptyQuery, matchesQuery, parseMailQuery, toProviderQuery } from "./query";
import {
  applyListing,
  ensureView,
  keyOfSummary,
  patchView,
  pruneThreads,
  pruneViews,
  setFolders,
  sortKeysNewestFirst,
  viewFromKnownThreads,
  type AccountListing,
} from "./reducers";
import { replyMetaFromThread } from "./drafts";
import type { StoreContext } from "./store-core";
import type { MailState } from "./types";

/** Full threads kept for instant reopening. */
export const MAX_RECENT_THREADS = 20;

type Fetcher = (cursor: string | undefined) => Promise<Page<ThreadSummary>>;

export interface ListActions {
  loadFolders(accountId: string): Promise<void>;
  openView(descriptor: ViewDescriptor): Promise<void>;
  refreshView(key?: ViewKey): Promise<void>;
  loadMore(key?: ViewKey): Promise<void>;
  setFilter(text: string): void;
  runSearch(text: string): Promise<void>;
  openThread(key: ThreadKey): Promise<void>;
  closeThread(): void;
  /** A full thread, from the open thread, the recent cache or the provider. */
  fullThread(key: ThreadKey): Promise<MailThread>;
  /** Wired by the store so opening a thread can mark it read. */
  onOpened?: (key: ThreadKey) => void;
}

export function createListActions(ctx: StoreContext): ListActions {
  const seq: Record<ViewKey, number> = {};
  let threadSeq = 0;
  const folderLoads: Partial<Record<string, Promise<void>>> = {};
  const recent = new LruCache<ThreadKey, MailThread>(MAX_RECENT_THREADS);

  const nextSeq = (key: ViewKey) => {
    seq[key] = (seq[key] ?? 0) + 1;
    for (const known of Object.keys(seq)) if (!ctx.get().views[known] && known !== key) delete seq[known];
    return seq[key];
  };

  async function loadFolders(accountId: string): Promise<void> {
    const pending = folderLoads[accountId];
    if (pending) return pending;
    const entry = ctx.entry(accountId);
    if (!entry) return;
    const run = (async () => {
      ctx.set((s) => ({ ...s, accounts: s.accounts.map((a) => a.account.id === accountId ? { ...a, foldersStatus: "loading" } : a) }));
      try {
        const folders = await entry.provider.listFolders();
        ctx.set((s) => setFolders(s, accountId, folders));
        await ctx.cache.saveFolders(accountId, folders);
      } catch (error: unknown) {
        ctx.log("folders.failed", error);
        const mailError = toMailError(error);
        ctx.set((s) => ({ ...s, accounts: s.accounts.map((a) => a.account.id === accountId ? { ...a, foldersStatus: "error", foldersError: mailError } : a) }));
      } finally {
        delete folderLoads[accountId];
      }
    })();
    folderLoads[accountId] = run;
    return run;
  }

  /** One fetcher per account the list draws from. */
  async function fetchersFor(descriptor: ViewDescriptor): Promise<Record<string, Fetcher>> {
    const fetchers: Record<string, Fetcher> = {};
    const limit = ctx.pageSize;
    if (descriptor.kind === "search") {
      const query = parseMailQuery(descriptor.query, { timeZone: ctx.timeZone });
      for (const { account, provider } of ctx.entries()) {
        const text = toProviderQuery(query, account.provider);
        fetchers[account.id] = (cursor) => provider.search(text, cursor);
      }
      return fetchers;
    }
    const accounts = descriptor.kind === "folder" ? ctx.entries().filter((e) => e.account.id === descriptor.accountId) : ctx.entries();
    // Folder lists are fetched for every account at once, so one slow mailbox does not hold up the others.
    await Promise.all(accounts.filter(({ account }) => !ctx.get().folders[account.id]).map(({ account }) => loadFolders(account.id)));
    for (const { account, provider } of accounts) {
      const folders = ctx.get().folders[account.id] ?? [];
      const folderId = descriptor.kind === "folder"
        ? descriptor.folderId
        : folders.find((folder) => folder.role === descriptor.role)?.id;
      if (!folderId) continue;
      fetchers[account.id] = (cursor) => provider.listThreads({ folderId, cursor, limit });
    }
    return fetchers;
  }

  async function fetchAll(fetchers: Record<string, Fetcher>, cursors: Record<string, string | undefined>) {
    const ids = Object.keys(fetchers);
    const settled = await Promise.allSettled(ids.map((id) => fetchers[id](cursors[id])));
    const listings: AccountListing[] = [];
    let error: MailError | null = null;
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        listings.push({ accountId: ids[i], items: result.value.items, nextCursor: result.value.nextCursor });
      } else {
        ctx.log("list.failed", result.reason);
        error ??= toMailError(result.reason);
      }
    });
    return { listings, error, attempted: ids.length };
  }

  function afterListing(state: MailState, listings: AccountListing[]): MailState {
    ctx.markDirty(listings.flatMap((listing) => listing.items.map(keyOfSummary)));
    return pruneThreads(state);
  }

  async function refreshView(key = ctx.get().activeView): Promise<void> {
    const view = ctx.get().views[key];
    if (!view) return;
    const mine = nextSeq(key);
    ctx.set((s) => patchView(s, key, { status: "loading", error: null }));
    const fetchers = await fetchersFor(view.descriptor);
    const { listings, error, attempted } = await fetchAll(fetchers, {});
    if (seq[key] !== mine) return;
    ctx.set((s) => {
      let next = listings.length ? applyListing(s, key, listings, "replace", ctx.now()) : s;
      const failedAll = attempted > 0 && listings.length === 0;
      const noAccount = attempted === 0;
      next = patchView(next, key, {
        error: noAccount ? localMailError(ctx.entries().length ? "unknown_folder" : "no_account") : error,
        status: failedAll || noAccount ? "error" : "ready",
      });
      return afterListing(next, listings);
    });
  }

  async function loadMore(key = ctx.get().activeView): Promise<void> {
    const view = ctx.get().views[key];
    if (!view || view.loadingMore || view.status === "loading") return;
    const cursors: Record<string, string> = {};
    for (const [accountId, cursor] of Object.entries(view.cursors)) if (typeof cursor === "string") cursors[accountId] = cursor;
    if (Object.keys(cursors).length === 0) return;
    const mine = seq[key] ?? 0;
    ctx.set((s) => patchView(s, key, { loadingMore: true }));
    const all = await fetchersFor(view.descriptor);
    const fetchers: Record<string, Fetcher> = {};
    for (const accountId of Object.keys(cursors)) if (all[accountId]) fetchers[accountId] = all[accountId];
    const { listings, error } = await fetchAll(fetchers, cursors);
    if ((seq[key] ?? 0) !== mine) {
      ctx.set((s) => patchView(s, key, { loadingMore: false }));
      return;
    }
    ctx.set((s) => {
      const next = listings.length ? applyListing(s, key, listings, "append", ctx.now()) : s;
      return afterListing(patchView(next, key, { loadingMore: false, error }), listings);
    });
  }

  async function openView(descriptor: ViewDescriptor): Promise<void> {
    const key = viewKeyOf(descriptor);
    ctx.set((s) => {
      let next = ensureView(s, descriptor);
      next = patchView({ ...next, activeView: key, focused: null, selection: { keys: [], anchor: null }, openThread: null }, key, { openedAt: ctx.now() });
      return pruneViews(viewFromKnownThreads(next, key));
    });
    await refreshView(key);
  }

  async function runSearch(text: string): Promise<void> {
    const query = parseMailQuery(text, { timeZone: ctx.timeZone });
    if (isEmptyQuery(query)) {
      await openView(UNIFIED_INBOX);
      return;
    }
    const descriptor: ViewDescriptor = { kind: "search", query: query.raw };
    const key = viewKeyOf(descriptor);
    ctx.set((s) => {
      const next = ensureView({ ...s, filter: "" }, descriptor);
      if (next.views[key].threadKeys.length > 0) return next;
      const local = Object.entries(next.threads).filter(([, summary]) => matchesQuery(summary, query)).map(([k]) => k);
      return patchView(next, key, { threadKeys: sortKeysNewestFirst(local, next.threads), fromCache: local.length > 0 });
    });
    await openView(descriptor);
  }

  async function fullThread(key: ThreadKey): Promise<MailThread> {
    const state = ctx.get();
    if (state.openThread?.key === key && state.openThread.thread) return state.openThread.thread;
    const cached = recent.get(key);
    if (cached) return cached;
    const summary = state.threads[key];
    const entry = summary ? ctx.entry(summary.accountId) : undefined;
    if (!summary || !entry) throw localMailError("thread_unavailable");
    const thread = await entry.provider.getThread(summary.id);
    recent.set(key, thread);
    return thread;
  }

  async function openThread(key: ThreadKey): Promise<void> {
    const summary = ctx.get().threads[key];
    const entry = summary ? ctx.entry(summary.accountId) : undefined;
    if (!summary || !entry) {
      ctx.fail(localMailError("thread_unavailable"));
      return;
    }
    const mine = ++threadSeq;
    const cached = recent.get(key) ?? null;
    ctx.set((s) => ({ ...s, focused: key, openThread: { key, status: "loading", thread: cached, error: null } }));
    actions.onOpened?.(key);
    try {
      const thread = await entry.provider.getThread(summary.id);
      recent.set(key, thread);
      if (mine !== threadSeq || ctx.get().openThread?.key !== key) return;
      const meta = replyMetaFromThread(thread, entry.account);
      ctx.set((s) => ({
        ...s,
        openThread: { key, status: "ready", thread, error: null },
        replyMeta: meta ? { ...s.replyMeta, [key]: meta } : s.replyMeta,
      }));
      ctx.markDirty([key]);
    } catch (error: unknown) {
      ctx.log("thread.failed", error);
      if (mine !== threadSeq || ctx.get().openThread?.key !== key) return;
      const mailError = toMailError(error);
      ctx.set((s) => ({ ...s, openThread: { key, status: "error", thread: s.openThread?.thread ?? null, error: mailError } }));
    }
  }

  const actions: ListActions = {
    loadFolders,
    openView,
    refreshView,
    loadMore,
    setFilter(text) {
      const filter = text.slice(0, MAX_QUERY_CHARS);
      ctx.set((s) => (s.filter === filter ? s : { ...s, filter }));
    },
    runSearch,
    openThread,
    closeThread() {
      threadSeq += 1;
      ctx.set((s) => (s.openThread ? { ...s, openThread: null } : s));
    },
    fullThread,
  };
  return actions;
}
