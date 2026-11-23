/**
 * `createMailStore`: the framework-free Mail store.
 *
 *   const store = createMailStore({ accounts: [{ account, provider }] });
 *   const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
 *   useEffect(() => { void store.start(); return () => void store.dispose(); }, []);
 *
 * State is serialisable and replaced, never mutated. Actions resolve once the
 * provider settles; their effects reach the state through `subscribe`.
 */
import type { IsoInstant } from "../../../_shared/office-accounts/types/mail";
import type { MailCommand } from "./keyboard";
import type { ThreadKey, ViewDescriptor, ViewKey } from "./ids";
import {
  applyCache,
  clearSelection,
  initialMailState,
  moveFocus,
  selectAll,
  selectRange,
  setFocus,
  toggleSelected,
} from "./reducers";
import { selectTargetKeys, selectVisibleThreadKeys } from "./selectors";
import { createStoreContext, type MailAccountEntry, type MailStoreOptions } from "./store-core";
import { createDraftActions, type DraftEdit } from "./store-drafts";
import { createListActions } from "./store-lists";
import { createTriageActions, type ProviderTriageKind, type TriageOptions } from "./store-triage";
import type { DraftKind, MailState } from "./types";

/** How often due snoozes are woken. */
export const SNOOZE_CHECK_MS = 60_000;

/** What the UI should do after a keyboard command, beyond the state change. */
export type MailCommandEffect = "focusSearch" | "showComposer" | null;

export interface MailCommandResult {
  handled: boolean;
  effect: MailCommandEffect;
}

export interface MailStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MailState;
  /** Paints the cache, loads folders and refreshes the active list. */
  start(): Promise<void>;
  /** Stops timers and writes pending cache rows. */
  dispose(): Promise<void>;
  setAccounts(accounts: MailAccountEntry[]): Promise<void>;

  /** The rows of the active list after snoozes and the filter. */
  visibleThreadKeys(): ThreadKey[];
  openView(descriptor: ViewDescriptor): Promise<void>;
  refresh(key?: ViewKey): Promise<void>;
  loadMore(key?: ViewKey): Promise<void>;
  loadFolders(accountId: string): Promise<void>;
  /** Instant local filter over the active list. */
  setFilter(text: string): void;
  /** Provider search across every account, painted first from cached matches. */
  search(text: string): Promise<void>;
  openThread(key: ThreadKey): Promise<void>;
  closeThread(): void;

  focus(key: ThreadKey | null): void;
  toggleSelect(key: ThreadKey): void;
  /** Shift-click: selects from the anchor to `key`. */
  selectRangeTo(key: ThreadKey): void;
  selectAllVisible(): void;
  clearSelection(): void;
  clearError(): void;

  triage(kind: ProviderTriageKind, options?: TriageOptions): Promise<boolean>;
  archive(keys?: ThreadKey[]): Promise<boolean>;
  trash(keys?: ThreadKey[]): Promise<boolean>;
  moveTo(folderId: string, keys?: ThreadKey[]): Promise<boolean>;
  markRead(read: boolean, keys?: ThreadKey[]): Promise<boolean>;
  setFlag(flagged: boolean, keys?: ThreadKey[]): Promise<boolean>;
  snooze(until: IsoInstant, keys?: ThreadKey[]): boolean;
  unsnooze(keys?: ThreadKey[]): boolean;
  undo(): Promise<boolean>;
  dismissUndo(): void;

  compose(accountId?: string): string | null;
  respond(kind: Exclude<DraftKind, "new">, options?: { key?: ThreadKey; messageId?: string }): Promise<string | null>;
  /** Opens a draft the provider stores for editing; see `DraftActions.editProviderDraft`. */
  editProviderDraft(key: ThreadKey, messageId: string, options?: { bodyHtml?: string }): Promise<string | null>;
  editDraft(localId: string, edit: DraftEdit): void;
  saveDraft(localId: string): Promise<void>;
  closeDraft(localId: string): void;
  openDraft(localId: string): void;
  discardDraft(localId: string): Promise<void>;
  /** Call only from an explicit owner click on Send. */
  sendDraft(localId: string): Promise<boolean>;

  runCommand(command: MailCommand): Promise<MailCommandResult>;
}

export function createMailStore(options: MailStoreOptions): MailStore {
  const ctx = createStoreContext(initialMailState(options.accounts.map((entry) => entry.account)), options);
  const lists = createListActions(ctx);
  const triage = createTriageActions(ctx);
  const drafts = createDraftActions(ctx, lists);
  let snoozeTimer: unknown = null;

  lists.onOpened = (key) => {
    if (ctx.markReadOnOpen && ctx.get().threads[key]?.unread) {
      void triage.triage("markRead", { keys: [key], recordUndo: false });
    }
  };

  const visible = () => selectVisibleThreadKeys(ctx.get(), ctx.now(), ctx.timeZone);

  async function loadEverything(): Promise<void> {
    await Promise.all(ctx.entries().map((entry) => lists.loadFolders(entry.account.id)));
    await lists.refreshView();
  }

  const done = (effect: MailCommandEffect = null): MailCommandResult => ({ handled: true, effect });

  async function followFocus(): Promise<void> {
    const state = ctx.get();
    if (state.openThread && state.focused && state.focused !== state.openThread.key) await lists.openThread(state.focused);
  }

  const store: MailStore = {
    subscribe: ctx.subscribe,
    getSnapshot: ctx.get,

    async start() {
      try {
        const cached = await ctx.cache.load(ctx.entries().map((entry) => entry.account.id));
        ctx.set((s) => applyCache(s, cached));
      } catch (error: unknown) {
        ctx.log("cache.load.failed", error);
        ctx.set((s) => ({ ...s, cacheLoaded: true }));
      }
      triage.wakeDueSnoozes();
      if (snoozeTimer === null && !ctx.isDisposed()) snoozeTimer = ctx.timers.setInterval(() => triage.wakeDueSnoozes(), SNOOZE_CHECK_MS);
      await loadEverything();
    },

    async dispose() {
      if (snoozeTimer !== null) ctx.timers.clearInterval(snoozeTimer);
      snoozeTimer = null;
      drafts.dispose();
      await ctx.flushCache();
      ctx.dispose();
    },

    async setAccounts(accounts) {
      ctx.setEntries(accounts);
      const ids = new Set(accounts.map((entry) => entry.account.id));
      ctx.set((s) => {
        const threads = Object.fromEntries(Object.entries(s.threads).filter(([, summary]) => ids.has(summary.accountId)));
        const views = Object.fromEntries(Object.entries(s.views).map(([key, view]) => [key, { ...view, threadKeys: view.threadKeys.filter((k) => threads[k]) }]));
        return {
          ...s,
          accounts: accounts.map(({ account }) => s.accounts.find((a) => a.account.id === account.id) ?? { account, foldersStatus: "idle", foldersError: null }),
          folders: Object.fromEntries(Object.entries(s.folders).filter(([id]) => ids.has(id))),
          threads,
          views,
          selection: { keys: s.selection.keys.filter((k) => threads[k]), anchor: null },
        };
      });
      await loadEverything();
    },

    visibleThreadKeys: visible,
    openView: lists.openView,
    refresh: lists.refreshView,
    loadMore: lists.loadMore,
    loadFolders: lists.loadFolders,
    setFilter: lists.setFilter,
    search: lists.runSearch,
    openThread: lists.openThread,
    closeThread: lists.closeThread,

    focus: (key) => ctx.set((s) => setFocus(s, key)),
    toggleSelect: (key) => ctx.set((s) => toggleSelected(s, key)),
    selectRangeTo: (key) => ctx.set((s) => selectRange(s, key, visible())),
    selectAllVisible: () => ctx.set((s) => selectAll(s, visible())),
    clearSelection: () => ctx.set(clearSelection),
    clearError: () => ctx.set((s) => (s.error ? { ...s, error: null } : s)),

    triage: triage.triage,
    archive: (keys) => triage.triage("archive", { keys }),
    trash: (keys) => triage.triage("trash", { keys }),
    moveTo: (folderId, keys) => triage.triage("move", { keys, toFolderId: folderId }),
    markRead: (read, keys) => triage.triage(read ? "markRead" : "markUnread", { keys }),
    setFlag: (flagged, keys) => triage.triage(flagged ? "flag" : "unflag", { keys }),
    snooze: triage.snooze,
    unsnooze: triage.unsnooze,
    undo: triage.undo,
    dismissUndo: triage.dismissUndo,

    compose: drafts.compose,
    respond: drafts.respond,
    editProviderDraft: drafts.editProviderDraft,
    editDraft: drafts.editDraft,
    saveDraft: drafts.saveDraft,
    closeDraft: drafts.closeDraft,
    openDraft: drafts.openDraft,
    discardDraft: drafts.discardDraft,
    sendDraft: drafts.sendDraft,

    async runCommand(command) {
      const state = ctx.get();
      switch (command) {
        case "focusNext":
        case "focusPrevious":
          ctx.set((s) => moveFocus(s, command === "focusNext" ? 1 : -1, visible()));
          await followFocus();
          return done();
        case "extendNext":
        case "extendPrevious":
          ctx.set((s) => moveFocus(s, command === "extendNext" ? 1 : -1, visible(), true));
          return done();
        case "open":
          if (!state.focused) return { handled: false, effect: null };
          await lists.openThread(state.focused);
          return done();
        case "close":
          if (state.openThread) lists.closeThread();
          else ctx.set(clearSelection);
          return done();
        case "archive":
        case "trash":
        case "markRead":
        case "markUnread":
          await triage.triage(command);
          return done();
        case "toggleFlag": {
          const keys = selectTargetKeys(state);
          const allFlagged = keys.length > 0 && keys.every((key) => state.threads[key]?.flagged);
          await triage.triage(allFlagged ? "unflag" : "flag", { keys });
          return done();
        }
        case "reply":
        case "replyAll":
        case "forward":
          return done((await drafts.respond(command)) ? "showComposer" : null);
        case "compose":
          return done(drafts.compose() ? "showComposer" : null);
        case "search":
          return done("focusSearch");
        case "toggleSelect":
          if (!state.focused) return { handled: false, effect: null };
          ctx.set((s) => toggleSelected(s, state.focused!));
          return done();
        case "undo":
          await triage.undo();
          return done();
        case "selectAll":
          ctx.set((s) => selectAll(s, visible()));
          return done();
        case "clearSelection":
          ctx.set(clearSelection);
          return done();
      }
    },
  };
  return store;
}
