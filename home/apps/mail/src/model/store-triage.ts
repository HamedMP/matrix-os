/**
 * Optimistic triage with rollback, local snooze and single-step undo.
 *
 * A triage action is shown at once, then sent as one `modifyThreads` call per
 * account, per identical change and per `MAX_MODIFY_THREADS` threads. Each
 * call settles on its own: a failed call puts back only its own threads and
 * raises an allowlisted error, the others stay applied.
 */
import {
  MAX_MODIFY_THREADS,
  ProviderError,
  isEmptyThreadChange,
  type IsoInstant,
  type ThreadChange,
} from "../../../_shared/office-accounts/types/mail";
import { localMailError, toMailError, type MailError } from "./errors";
import { localId, threadKey, type ThreadKey } from "./ids";
import { applyOptimistic, commitPending, focusAfterRemoval, providerOf, rollbackPending, setSnoozes } from "./reducers";
import { selectTargetKeys, selectVisibleThreadKeys } from "./selectors";
import type { StoreContext } from "./store-core";
import { inverseChange, triageChangeFor } from "./thread-ops";
import type { MailState, PendingTriage, ThreadChangeItem, TriageKind } from "./types";

export type ProviderTriageKind = Exclude<TriageKind, "snooze" | "unsnooze" | "undo">;

export interface TriageOptions {
  /** Defaults to the selection, else the focused thread. */
  keys?: ThreadKey[];
  /** Required for `move`. */
  toFolderId?: string;
  /** False for changes the owner did not ask for (marking read on open). Default true. */
  recordUndo?: boolean;
}

export interface TriageActions {
  /** Resolves true when every provider call succeeded. */
  triage(kind: ProviderTriageKind, options?: TriageOptions): Promise<boolean>;
  snooze(until: IsoInstant, keys?: ThreadKey[]): boolean;
  unsnooze(keys?: ThreadKey[]): boolean;
  undo(): Promise<boolean>;
  dismissUndo(): void;
  wakeDueSnoozes(): void;
}

const VERBS: Record<TriageKind, string> = {
  archive: "Archived", trash: "Moved to trash", move: "Moved", markRead: "Marked as read",
  markUnread: "Marked as unread", flag: "Flagged", unflag: "Unflagged", snooze: "Snoozed",
  unsnooze: "Unsnoozed", undo: "Restored",
};

const NEEDS_FOLDERS: ReadonlySet<TriageKind> = new Set(["archive", "trash", "move"]);

export function triageLabel(kind: TriageKind, count: number): string {
  return `${VERBS[kind]} ${count} conversation${count === 1 ? "" : "s"}`;
}

function changeKey(change: ThreadChange): string {
  return JSON.stringify([change.addFolders ?? [], change.removeFolders ?? [], change.read ?? null, change.flagged ?? null]);
}

export function createTriageActions(ctx: StoreContext): TriageActions {
  /** Applies `state` changes and moves focus off rows that left the visible list. */
  function setWithFocus(update: (state: MailState) => MailState, keepSelection = false): void {
    ctx.set((state) => {
      const before = selectVisibleThreadKeys(state, ctx.now(), ctx.timeZone);
      const next = update(state);
      if (next === state) return state;
      const after = new Set(selectVisibleThreadKeys(next, ctx.now(), ctx.timeZone));
      const removed = before.filter((key) => !after.has(key));
      const focused = focusAfterRemoval(before, removed, next.focused);
      const openThread = next.openThread && removed.includes(next.openThread.key) ? null : next.openThread;
      return { ...next, focused, openThread, selection: keepSelection ? next.selection : { keys: [], anchor: null } };
    });
  }

  /** Groups per-thread changes into provider calls. */
  function buildOps(kind: TriageKind, items: ThreadChangeItem[], state: MailState): PendingTriage[] {
    const groups: Record<string, ThreadChangeItem[]> = {};
    for (const item of items) {
      const summary = state.threads[item.key];
      if (!summary || isEmptyThreadChange(item.change)) continue;
      (groups[`${summary.accountId}\u001f${changeKey(item.change)}`] ??= []).push(item);
    }
    const ops: PendingTriage[] = [];
    for (const group of Object.values(groups)) {
      for (let i = 0; i < group.length; i += MAX_MODIFY_THREADS) {
        const changes = group.slice(i, i + MAX_MODIFY_THREADS);
        ops.push({ id: localId("triage"), kind, changes, before: Object.fromEntries(changes.map((c) => [c.key, state.threads[c.key]])) });
      }
    }
    return ops;
  }

  /** Shows `items` at once, sends them, and rolls back the calls that fail. Returns the ops that succeeded. */
  async function runChanges(kind: TriageKind, items: ThreadChangeItem[], quiet = false): Promise<{ succeeded: PendingTriage[]; error: MailError | null }> {
    const ops = buildOps(kind, items, ctx.get());
    if (ops.length === 0) return { succeeded: [], error: null };
    setWithFocus((state) => ops.reduce(applyOptimistic, state), quiet);
    ctx.markDirty(items.map((item) => item.key));
    const results = await Promise.allSettled(ops.map((op) => {
      const accountId = op.before[op.changes[0].key].accountId;
      const entry = ctx.entry(accountId);
      if (!entry) return Promise.reject(new ProviderError("not_connected"));
      return entry.provider.modifyThreads(op.changes.map((c) => op.before[c.key].id), op.changes[0].change);
    }));
    const succeeded: PendingTriage[] = [];
    let error: MailError | null = null;
    ctx.set((state) => results.reduce((next, result, i) => {
      if (result.status === "fulfilled") {
        succeeded.push(ops[i]);
        return commitPending(next, ops[i].id);
      }
      ctx.log("triage.failed", result.reason);
      error ??= toMailError(result.reason);
      return rollbackPending(next, ops[i].id);
    }, state));
    ctx.markDirty(items.map((item) => item.key));
    if (error) ctx.fail(error);
    return { succeeded, error };
  }

  function itemsFor(kind: ProviderTriageKind, keys: ThreadKey[], options: TriageOptions): ThreadChangeItem[] | MailError {
    const state = ctx.get();
    const summaries = keys.map((key) => state.threads[key]).filter((s) => s !== undefined);
    if (summaries.length === 0) return localMailError("nothing_selected");
    if (kind === "move" && new Set(summaries.map((s) => s.accountId)).size > 1) return localMailError("mixed_accounts");
    const view = state.views[state.activeView]?.descriptor;
    const items: ThreadChangeItem[] = [];
    for (const summary of summaries) {
      const folders = state.folders[summary.accountId];
      const provider = providerOf(state, summary.accountId);
      if (!provider || (NEEDS_FOLDERS.has(kind) && !folders?.length)) return localMailError("unknown_folder");
      const fromFolderId = view?.kind === "folder" && view.accountId === summary.accountId
        ? view.folderId
        : view?.kind === "unified" ? folders?.find((f) => f.role === view.role)?.id : undefined;
      try {
        const change = triageChangeFor(kind, summary, { folders: folders ?? [], provider, fromFolderId, toFolderId: options.toFolderId });
        items.push({ key: threadKey(summary.accountId, summary.id), change });
      } catch (error: unknown) {
        if (error instanceof RangeError) return localMailError("unknown_folder");
        return toMailError(error);
      }
    }
    return items;
  }

  function persistSnoozes(entries: Record<ThreadKey, IsoInstant | null>): void {
    const state = ctx.get();
    const rows: Record<ThreadKey, { accountId: string; until: IsoInstant | null }> = {};
    for (const [key, until] of Object.entries(entries)) {
      const accountId = state.threads[key]?.accountId;
      if (accountId) rows[key] = { accountId, until };
    }
    void ctx.cache.saveSnoozes(rows);
  }

  function changeSnoozes(kind: "snooze" | "unsnooze", until: IsoInstant | null, keys: ThreadKey[] | undefined): boolean {
    const targets = (keys ?? selectTargetKeys(ctx.get())).filter((key) => ctx.get().threads[key]);
    if (targets.length === 0) {
      ctx.fail(localMailError("nothing_selected"));
      return false;
    }
    const previous = Object.fromEntries(targets.map((key) => [key, ctx.get().snoozed[key] ?? null]));
    const entries = Object.fromEntries(targets.map((key) => [key, until]));
    setWithFocus((state) => ({
      ...setSnoozes(state, entries),
      undo: { kind, label: triageLabel(kind, targets.length), changes: [], snoozes: previous, at: ctx.now() },
    }));
    persistSnoozes(entries);
    return true;
  }

  return {
    async triage(kind, options = {}) {
      const keys = options.keys ?? selectTargetKeys(ctx.get());
      const items = itemsFor(kind, [...keys], options);
      if (!Array.isArray(items)) {
        ctx.fail(items);
        return false;
      }
      const { succeeded, error } = await runChanges(kind, items, options.recordUndo === false);
      if (options.recordUndo !== false && succeeded.length > 0) {
        const state = ctx.get();
        const changes = succeeded.flatMap((op) => op.changes.map((item) => {
          const before = op.before[item.key];
          return { key: item.key, change: inverseChange(before, item.change, providerOf(state, before.accountId) ?? "gmail") };
        }));
        const count = changes.length;
        ctx.set((s) => ({ ...s, undo: { kind, label: triageLabel(kind, count), changes, snoozes: {}, at: ctx.now() } }));
      }
      return error === null;
    },

    snooze: (until, keys) => changeSnoozes("snooze", until, keys),
    unsnooze: (keys) => changeSnoozes("unsnooze", null, keys),

    async undo() {
      const entry = ctx.get().undo;
      if (!entry) return false;
      ctx.set((s) => ({ ...s, undo: null }));
      if (Object.keys(entry.snoozes).length) {
        setWithFocus((state) => setSnoozes(state, entry.snoozes));
        persistSnoozes(entry.snoozes);
      }
      const { error } = await runChanges("undo", entry.changes);
      return error === null;
    },

    dismissUndo() {
      ctx.set((s) => (s.undo ? { ...s, undo: null } : s));
    },

    wakeDueSnoozes() {
      const now = ctx.now();
      const due = Object.entries(ctx.get().snoozed).filter(([, until]) => Date.parse(until) <= now).map(([key]) => key);
      if (due.length === 0) return;
      const entries = Object.fromEntries(due.map((key) => [key, null]));
      ctx.set((state) => setSnoozes(state, entries));
      persistSnoozes(entries);
    },
  };
}
