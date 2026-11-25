/**
 * Pure state transitions for the Mail store. Every function returns a new
 * state and never mutates its input.
 */
import {
  instantToMs,
  type IsoInstant,
  type MailAccount,
  type MailFolder,
  type MailProviderId,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";
import { UNIFIED_INBOX, threadKey, viewKeyOf, type ThreadKey, type ViewDescriptor, type ViewKey } from "./ids";
import { applyChangeToSummary, belongsToView, inverseChange } from "./thread-ops";
import type { MailState, PendingTriage, ReplyMeta, ThreadView } from "./types";

/** Summaries kept in memory; ones no list, draft or open thread uses are dropped first. */
export const MAX_THREADS_IN_MEMORY = 2000;
/** Thread lists kept in memory; the least recently opened search lists go first. */
export const MAX_VIEWS = 24;

export function initialMailState(accounts: readonly MailAccount[] = []): MailState {
  const inbox = emptyView(UNIFIED_INBOX);
  return {
    accounts: accounts.map((account) => ({ account, foldersStatus: "idle", foldersError: null })),
    folders: {},
    threads: {},
    replyMeta: {},
    snoozed: {},
    views: { [inbox.key]: inbox },
    activeView: inbox.key,
    filter: "",
    focused: null,
    selection: { keys: [], anchor: null },
    openThread: null,
    pending: [],
    undo: null,
    error: null,
    drafts: {},
    activeDraftId: null,
    cacheLoaded: false,
  };
}

export function emptyView(descriptor: ViewDescriptor): ThreadView {
  return {
    key: viewKeyOf(descriptor), descriptor, threadKeys: [], cursors: {},
    status: "idle", loadingMore: false, error: null, fromCache: false, loadedAt: null, openedAt: null,
  };
}

export function providerOf(state: MailState, accountId: string): MailProviderId | undefined {
  return state.accounts.find((entry) => entry.account.id === accountId)?.account.provider;
}

export function keyOfSummary(summary: ThreadSummary): ThreadKey {
  return threadKey(summary.accountId, summary.id);
}

function ms(instant: IsoInstant): number {
  try {
    return instantToMs(instant);
  } catch (error: unknown) {
    if (error instanceof RangeError) return 0;
    throw error;
  }
}

export function sortKeysNewestFirst(keys: ThreadKey[], threads: Record<ThreadKey, ThreadSummary>): ThreadKey[] {
  return [...keys].sort((a, b) => ms(threads[b]?.lastMessageAt ?? "") - ms(threads[a]?.lastMessageAt ?? ""));
}

export function hasMorePages(view: ThreadView): boolean {
  return Object.values(view.cursors).some((cursor) => cursor !== null);
}

export function ensureView(state: MailState, descriptor: ViewDescriptor): MailState {
  const key = viewKeyOf(descriptor);
  if (state.views[key]) return state;
  return { ...state, views: { ...state.views, [key]: emptyView(descriptor) } };
}

export function patchView(state: MailState, key: ViewKey, patch: Partial<ThreadView>): MailState {
  const view = state.views[key];
  if (!view) return state;
  return { ...state, views: { ...state.views, [key]: { ...view, ...patch } } };
}

export function setFolders(state: MailState, accountId: string, folders: MailFolder[]): MailState {
  return {
    ...state,
    folders: { ...state.folders, [accountId]: folders },
    accounts: state.accounts.map((entry) => entry.account.id === accountId
      ? { ...entry, foldersStatus: "ready", foldersError: null }
      : entry),
  };
}

/** A provider summary with every in-flight optimistic change re-applied. */
function withPending(state: MailState, summary: ThreadSummary): ThreadSummary {
  const key = keyOfSummary(summary);
  const provider = providerOf(state, summary.accountId) ?? "gmail";
  let result = summary;
  for (const op of state.pending) {
    for (const item of op.changes) if (item.key === key) result = applyChangeToSummary(result, item.change, provider);
  }
  return result;
}

export interface AccountListing {
  accountId: string;
  items: ThreadSummary[];
  nextCursor: string | null;
}

/**
 * Applies provider listings to a view. `replace` swaps the keys of the listed
 * accounts (other accounts keep theirs, so one failing account in the unified
 * inbox does not empty it); `append` adds a further page.
 */
export function applyListing(
  state: MailState,
  viewKey: ViewKey,
  listings: AccountListing[],
  mode: "replace" | "append",
  now: number,
): MailState {
  const view = state.views[viewKey];
  if (!view) return state;
  const threads = { ...state.threads };
  const listed = new Set(listings.map((listing) => listing.accountId));
  const incoming: ThreadKey[] = [];
  for (const listing of listings) {
    for (const raw of listing.items) {
      if (raw.accountId !== listing.accountId) continue;
      const summary = withPending(state, raw);
      const key = keyOfSummary(summary);
      threads[key] = summary;
      if (belongsToView(view.descriptor, summary, state.folders[summary.accountId])) incoming.push(key);
    }
  }
  const kept = mode === "append"
    ? view.threadKeys
    : view.threadKeys.filter((key) => {
      const summary = threads[key];
      return summary !== undefined && !listed.has(summary.accountId);
    });
  const merged = [...new Set([...kept, ...incoming])];
  const cursors = { ...view.cursors };
  for (const listing of listings) cursors[listing.accountId] = listing.nextCursor;
  const nextView: ThreadView = {
    ...view,
    threadKeys: sortKeysNewestFirst(merged, threads),
    cursors,
    status: "ready",
    loadingMore: false,
    fromCache: false,
    loadedAt: now,
  };
  return { ...state, threads, views: { ...state.views, [viewKey]: nextView } };
}

/** Rebuilds a folder or unified view from known summaries, for painting before the provider answers. */
export function viewFromKnownThreads(state: MailState, viewKey: ViewKey): MailState {
  const view = state.views[viewKey];
  if (!view || view.descriptor.kind === "search" || view.loadedAt !== null) return state;
  const keys = Object.entries(state.threads)
    .filter(([, summary]) => belongsToView(view.descriptor, summary, state.folders[summary.accountId]))
    .map(([key]) => key);
  return patchView(state, viewKey, { threadKeys: sortKeysNewestFirst(keys, state.threads), fromCache: keys.length > 0 });
}

export interface CachedMail {
  folders: Record<string, MailFolder[]>;
  threads: ThreadSummary[];
  replyMeta: Record<ThreadKey, ReplyMeta>;
  snoozes: Record<ThreadKey, IsoInstant>;
}

/** Paints cached data without overwriting anything fresher already in memory. */
export function applyCache(state: MailState, cached: CachedMail): MailState {
  const accountIds = new Set(state.accounts.map((entry) => entry.account.id));
  const threads = { ...state.threads };
  for (const summary of cached.threads) {
    const key = keyOfSummary(summary);
    if (accountIds.has(summary.accountId) && !threads[key]) threads[key] = summary;
  }
  const folders = { ...state.folders };
  for (const [accountId, list] of Object.entries(cached.folders)) {
    if (accountIds.has(accountId) && !folders[accountId]) folders[accountId] = list;
  }
  let next: MailState = {
    ...state,
    threads,
    folders,
    replyMeta: { ...cached.replyMeta, ...state.replyMeta },
    snoozed: { ...cached.snoozes, ...state.snoozed },
    cacheLoaded: true,
  };
  for (const key of Object.keys(next.views)) next = viewFromKnownThreads(next, key);
  return next;
}

/**
 * Adds or removes the given threads in every folder and unified view so the
 * lists match the summaries. A thread older than the last loaded row of a
 * list with further pages is left for paging to find.
 */
export function reconcileMembership(state: MailState, keys: readonly ThreadKey[]): MailState {
  const views = { ...state.views };
  for (const [viewKey, view] of Object.entries(state.views)) {
    if (view.descriptor.kind === "search") continue;
    let list = view.threadKeys;
    for (const key of keys) {
      const summary = state.threads[key];
      if (!summary) continue;
      const present = list.includes(key);
      const belongs = belongsToView(view.descriptor, summary, state.folders[summary.accountId]);
      if (present && !belongs) list = list.filter((k) => k !== key);
      if (!present && belongs) {
        const last = list.length ? state.threads[list[list.length - 1]] : undefined;
        const olderThanLoaded = last !== undefined && hasMorePages(view) && ms(summary.lastMessageAt) < ms(last.lastMessageAt);
        if (!olderThanLoaded) list = sortKeysNewestFirst([...list, key], state.threads);
      }
    }
    if (list !== view.threadKeys) views[viewKey] = { ...view, threadKeys: list };
  }
  return { ...state, views };
}

function applyChanges(state: MailState, op: PendingTriage, direction: "forward" | "inverse"): MailState {
  const threads = { ...state.threads };
  for (const item of op.changes) {
    const current = threads[item.key];
    const before = op.before[item.key];
    const provider = providerOf(state, (current ?? before)?.accountId ?? "") ?? "gmail";
    if (!current || !before) continue;
    const change = direction === "forward" ? item.change : inverseChange(before, item.change, provider);
    threads[item.key] = applyChangeToSummary(current, change, provider);
  }
  return { ...state, threads };
}

/** Shows the result of a triage operation before the provider confirms it. */
export function applyOptimistic(state: MailState, op: PendingTriage): MailState {
  const next = applyChanges({ ...state, pending: [...state.pending, op] }, op, "forward");
  return reconcileMembership(next, op.changes.map((item) => item.key));
}

/** Reverses an operation the provider rejected and forgets it. */
export function rollbackPending(state: MailState, opId: string): MailState {
  const op = state.pending.find((entry) => entry.id === opId);
  if (!op) return state;
  const next = applyChanges({ ...state, pending: state.pending.filter((entry) => entry.id !== opId) }, op, "inverse");
  return reconcileMembership(next, op.changes.map((item) => item.key));
}

export function commitPending(state: MailState, opId: string): MailState {
  return { ...state, pending: state.pending.filter((entry) => entry.id !== opId) };
}

// ------------------------------------------------------------------ selection and focus

export function setFocus(state: MailState, key: ThreadKey | null): MailState {
  return state.focused === key ? state : { ...state, focused: key };
}

export function toggleSelected(state: MailState, key: ThreadKey): MailState {
  const keys = state.selection.keys.includes(key)
    ? state.selection.keys.filter((k) => k !== key)
    : [...state.selection.keys, key];
  return { ...state, selection: { keys, anchor: key } };
}

/** Selects every visible thread between the anchor (or the focused thread) and `key`. */
export function selectRange(state: MailState, key: ThreadKey, visible: readonly ThreadKey[]): MailState {
  const anchor = state.selection.anchor ?? state.focused ?? key;
  const from = visible.indexOf(anchor);
  const to = visible.indexOf(key);
  if (to < 0) return state;
  const start = from < 0 ? to : Math.min(from, to);
  const end = from < 0 ? to : Math.max(from, to);
  const range = visible.slice(start, end + 1);
  const keys = [...new Set([...state.selection.keys, ...range])];
  return { ...state, selection: { keys, anchor }, focused: key };
}

export function selectAll(state: MailState, visible: readonly ThreadKey[]): MailState {
  return { ...state, selection: { keys: [...visible], anchor: visible[0] ?? null } };
}

export function clearSelection(state: MailState): MailState {
  return state.selection.keys.length === 0 && state.selection.anchor === null
    ? state
    : { ...state, selection: { keys: [], anchor: null } };
}

/** Moves focus by `delta` rows; with `extend`, also adds the rows passed to the selection. */
export function moveFocus(state: MailState, delta: number, visible: readonly ThreadKey[], extend = false): MailState {
  if (visible.length === 0) return setFocus(state, null);
  const index = state.focused ? visible.indexOf(state.focused) : -1;
  const nextIndex = index < 0 ? (delta >= 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + delta));
  const key = visible[nextIndex];
  if (!extend) return setFocus(state, key);
  const anchorState = state.selection.anchor || !state.focused ? state : { ...state, selection: { ...state.selection, anchor: state.focused } };
  return selectRange(anchorState, key, visible);
}

/** The row to focus after `removed` rows leave the list: the next one below, else the one above. */
export function focusAfterRemoval(visibleBefore: readonly ThreadKey[], removed: readonly ThreadKey[], focused: ThreadKey | null): ThreadKey | null {
  if (!focused || !removed.includes(focused)) return focused;
  const gone = new Set(removed);
  const index = visibleBefore.indexOf(focused);
  for (let i = index + 1; i < visibleBefore.length; i += 1) if (!gone.has(visibleBefore[i])) return visibleBefore[i];
  for (let i = index - 1; i >= 0; i -= 1) if (!gone.has(visibleBefore[i])) return visibleBefore[i];
  return null;
}

/** Drops summaries nothing refers to once there are more than `max`, oldest first. */
export function pruneThreads(state: MailState, max = MAX_THREADS_IN_MEMORY): MailState {
  const keys = Object.keys(state.threads);
  if (keys.length <= max) return state;
  const used = new Set<ThreadKey>();
  for (const view of Object.values(state.views)) for (const key of view.threadKeys) used.add(key);
  for (const op of state.pending) for (const item of op.changes) used.add(item.key);
  for (const draft of Object.values(state.drafts)) if (draft.sourceThreadKey) used.add(draft.sourceThreadKey);
  if (state.openThread) used.add(state.openThread.key);
  for (const key of state.selection.keys) used.add(key);
  const removable = sortKeysNewestFirst(keys.filter((key) => !used.has(key)), state.threads).reverse();
  const excess = keys.length - max;
  const drop = new Set(removable.slice(0, excess));
  if (drop.size === 0) return state;
  const threads: Record<ThreadKey, ThreadSummary> = {};
  const replyMeta: Record<ThreadKey, ReplyMeta> = {};
  for (const [key, summary] of Object.entries(state.threads)) if (!drop.has(key)) threads[key] = summary;
  for (const [key, meta] of Object.entries(state.replyMeta)) if (!drop.has(key)) replyMeta[key] = meta;
  return { ...state, threads, replyMeta };
}

/** Drops the oldest search lists once there are more than `max` lists. The active list stays. */
export function pruneViews(state: MailState, max = MAX_VIEWS): MailState {
  const keys = Object.keys(state.views);
  if (keys.length <= max) return state;
  const removable = keys
    .filter((key) => key !== state.activeView && state.views[key].descriptor.kind === "search")
    .sort((a, b) => (state.views[a].openedAt ?? 0) - (state.views[b].openedAt ?? 0));
  const drop = new Set(removable.slice(0, keys.length - max));
  if (drop.size === 0) return state;
  const views: Record<ViewKey, ThreadView> = {};
  for (const [key, view] of Object.entries(state.views)) if (!drop.has(key)) views[key] = view;
  return { ...state, views };
}

/** Sets or clears local snoozes. `null` wakes the thread. */
export function setSnoozes(state: MailState, entries: Record<ThreadKey, IsoInstant | null>): MailState {
  const snoozed = { ...state.snoozed };
  for (const [key, until] of Object.entries(entries)) {
    if (until === null) delete snoozed[key];
    else snoozed[key] = until;
  }
  return { ...state, snoozed };
}

/** Wakes every snooze due at `now`. Returns the same state when none is due. */
export function wakeDueSnoozes(state: MailState, now: number): MailState {
  const due = Object.entries(state.snoozed).filter(([, until]) => ms(until) <= now).map(([key]) => key);
  if (due.length === 0) return state;
  return setSnoozes(state, Object.fromEntries(due.map((key) => [key, null])));
}
