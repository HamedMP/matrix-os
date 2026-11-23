/**
 * Derived data for the UI. Every selector is pure. The list selectors
 * remember their last answer, so calling them on every render returns the
 * same array until the inputs change (safe with `useSyncExternalStore`).
 */
import {
  instantToMs,
  type MailFolder,
  type MailFolderRole,
  type ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";
import type { ThreadKey, ViewDescriptor } from "./ids";
import { isEmptyQuery, matchesQuery, parseMailQuery, type MailQuery } from "./query";
import { hasMorePages, sortKeysNewestFirst } from "./reducers";
import type { DraftState, MailState, ReplyMeta, ThreadView } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Threads older than this drop out of the "waiting" lists. */
export const WAITING_WINDOW_MS = 30 * DAY_MS;

function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastResult: R;
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && lastArgs.every((value, i) => Object.is(value, args[i]))) return lastResult;
    lastResult = fn(...args);
    lastArgs = args;
    return lastResult;
  };
}

function safeMs(instant: string): number {
  try {
    return instantToMs(instant);
  } catch (error: unknown) {
    if (error instanceof RangeError) return 0;
    throw error;
  }
}

function isSnoozed(snoozed: MailState["snoozed"], key: ThreadKey, now: number): boolean {
  const until = snoozed[key];
  return until !== undefined && safeMs(until) > now;
}

export function selectActiveView(state: MailState): ThreadView | undefined {
  return state.views[state.activeView];
}

/** True for lists that hide snoozed threads: the inbox of one account or of all. */
export function hidesSnoozed(descriptor: ViewDescriptor, folders: Record<string, MailFolder[]>): boolean {
  if (descriptor.kind === "unified") return descriptor.role === "inbox";
  if (descriptor.kind === "folder") return folders[descriptor.accountId]?.find((f) => f.id === descriptor.folderId)?.role === "inbox";
  return false;
}

const parseFilter = memo((filter: string, timeZone: string): MailQuery => parseMailQuery(filter, { timeZone }));

/** Rounds `now` to the minute so the memo is not defeated by a clock that ticks every render. */
function minute(now: number): number {
  return Math.floor(now / 60_000);
}

const visibleKeys = memo((
  keys: ThreadKey[],
  descriptor: ViewDescriptor,
  threads: Record<ThreadKey, ThreadSummary>,
  snoozed: MailState["snoozed"],
  folders: MailState["folders"],
  filter: string,
  timeZone: string,
  nowMinute: number,
): ThreadKey[] => {
  const now = nowMinute * 60_000;
  const hide = hidesSnoozed(descriptor, folders);
  const query = parseFilter(filter, timeZone);
  const filtering = !isEmptyQuery(query);
  return keys.filter((key) => {
    const summary = threads[key];
    if (!summary) return false;
    if (hide && isSnoozed(snoozed, key, now)) return false;
    return !filtering || matchesQuery(summary, query);
  });
});

/** The rows of the active list after snoozes and the instant filter. */
export function selectVisibleThreadKeys(state: MailState, now: number, timeZone = "UTC"): ThreadKey[] {
  const view = selectActiveView(state);
  if (!view) return EMPTY;
  return visibleKeys(view.threadKeys, view.descriptor, state.threads, state.snoozed, state.folders, state.filter, timeZone, minute(now));
}

const EMPTY: ThreadKey[] = [];

export function selectHasMore(state: MailState): boolean {
  const view = selectActiveView(state);
  return view ? hasMorePages(view) : false;
}

export function selectFocusedSummary(state: MailState): ThreadSummary | null {
  return state.focused ? state.threads[state.focused] ?? null : null;
}

/** The keys a triage command acts on: the selection, else the focused row. */
export function selectTargetKeys(state: MailState): ThreadKey[] {
  if (state.selection.keys.length > 0) return state.selection.keys;
  return state.focused ? [state.focused] : EMPTY;
}

export interface FolderNode {
  folder: MailFolder;
  depth: number;
  children: FolderNode[];
}

const ROLE_ORDER: MailFolderRole[] = ["inbox", "starred", "drafts", "sent", "archive", "spam", "trash", "custom"];

/** The folders of one account as a tree: system folders first, then custom folders by name. */
export const selectFolderTree = memo((folders: MailFolder[] | undefined): FolderNode[] => {
  const list = folders ?? [];
  const ids = new Set(list.map((folder) => folder.id));
  const byParent: Record<string, MailFolder[]> = {};
  for (const folder of list) {
    const parent = folder.parentId && ids.has(folder.parentId) && folder.parentId !== folder.id ? folder.parentId : "";
    (byParent[parent] ??= []).push(folder);
  }
  const order = (a: MailFolder, b: MailFolder) =>
    ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name);
  const visited = new Set<string>();
  const build = (parent: string, depth: number): FolderNode[] =>
    (byParent[parent] ?? []).sort(order).flatMap((folder) => {
      if (visited.has(folder.id) || depth > 16) return [];
      visited.add(folder.id);
      return [{ folder, depth, children: build(folder.id, depth + 1) }];
    });
  return build("", 0);
});

/** Unread inbox threads per account, from the provider counts when present. */
export function selectInboxUnread(state: MailState): Record<string, number> {
  const result: Record<string, number> = {};
  for (const { account } of state.accounts) {
    result[account.id] = state.folders[account.id]?.find((folder) => folder.role === "inbox")?.unreadCount ?? 0;
  }
  return result;
}

function roleIds(folders: MailFolder[] | undefined, roles: MailFolderRole[]): string[] {
  return (folders ?? []).filter((folder) => roles.includes(folder.role) && !folder.virtual).map((folder) => folder.id);
}

type WaitingState = "you" | "them" | null;

/**
 * Who the thread waits on. With a fresh `ReplyMeta` (learned from the open
 * thread and still matching the summary) the answer is exact. Without one, a
 * thread in the inbox but never in sent is waiting on the owner, and one in
 * sent but not in the inbox is waiting on the other side; anything else is
 * unknown and left out.
 */
export function waitingState(summary: ThreadSummary, meta: ReplyMeta | undefined, folders: MailFolder[] | undefined): WaitingState {
  if (roleIds(folders, ["trash", "spam", "drafts"]).some((id) => summary.folderIds.includes(id))) return null;
  if (meta && safeMs(meta.lastAt) === safeMs(summary.lastMessageAt)) return meta.ownerSentLast ? "them" : "you";
  const inInbox = roleIds(folders, ["inbox"]).some((id) => summary.folderIds.includes(id));
  const inSent = roleIds(folders, ["sent"]).some((id) => summary.folderIds.includes(id));
  if (inInbox && !inSent) return "you";
  if (inSent && !inInbox) return "them";
  return null;
}

const waitingLists = memo((
  threads: Record<ThreadKey, ThreadSummary>,
  replyMeta: Record<ThreadKey, ReplyMeta>,
  folders: MailState["folders"],
  snoozed: MailState["snoozed"],
  nowMinute: number,
  windowMs: number,
): { you: ThreadKey[]; them: ThreadKey[] } => {
  const now = nowMinute * 60_000;
  const since = now - windowMs;
  const you: ThreadKey[] = [];
  const them: ThreadKey[] = [];
  for (const [key, summary] of Object.entries(threads)) {
    if (isSnoozed(snoozed, key, now) || safeMs(summary.lastMessageAt) < since) continue;
    const state = waitingState(summary, replyMeta[key], folders[summary.accountId]);
    if (state === "you") you.push(key);
    else if (state === "them") them.push(key);
  }
  return { you: sortKeysNewestFirst(you, threads), them: sortKeysNewestFirst(them, threads) };
});

/** Recent threads where someone else wrote last and the owner has not replied. Newest first. */
export function selectWaitingOnYou(state: MailState, now: number, windowMs = WAITING_WINDOW_MS): ThreadKey[] {
  return waitingLists(state.threads, state.replyMeta, state.folders, state.snoozed, minute(now), windowMs).you;
}

/** Recent threads where the owner wrote last and is waiting for an answer. Newest first. */
export function selectAwaitingThem(state: MailState, now: number, windowMs = WAITING_WINDOW_MS): ThreadKey[] {
  return waitingLists(state.threads, state.replyMeta, state.folders, state.snoozed, minute(now), windowMs).them;
}

/** Drafts the owner has open, most recently started last. */
export const selectOpenDrafts = memo((drafts: Record<string, DraftState>): DraftState[] =>
  Object.values(drafts).filter((draft) => draft.open));

export function selectActiveDraft(state: MailState): DraftState | null {
  return state.activeDraftId ? state.drafts[state.activeDraftId] ?? null : null;
}

/** Whether the draft has edits the provider does not hold yet. */
export function isDraftDirty(draft: DraftState): boolean {
  return draft.revision > draft.savedRevision;
}

export function selectIsTriagePending(state: MailState, key: ThreadKey): boolean {
  return state.pending.some((op) => op.changes.some((item) => item.key === key));
}
