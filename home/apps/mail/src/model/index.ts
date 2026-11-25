/**
 * The Mail app's model: state, domain logic and the store. No React here.
 *
 * ## Wiring
 *
 *   import { createMailStore, selectVisibleThreadKeys } from "./model";
 *   const store = createMailStore({ accounts: [{ account, provider }] });
 *   const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
 *   useEffect(() => { void store.start(); return () => void store.dispose(); }, [store]);
 *
 * `provider` is a `MailProvider` (one per account, from the office-accounts
 * adapters). `start()` paints the `MatrixOS.db` cache, loads folders and
 * refreshes the active list (the unified inbox by default).
 *
 * ## State (`MailState`)
 *
 * - `threads`: every known `ThreadSummary` keyed by `ThreadKey` (account + thread).
 * - `views[activeView]`: the active list (`ThreadView`) with `threadKeys`, `status`,
 *   `error`, `loadingMore`, `fromCache`. Render rows from `store.visibleThreadKeys()`
 *   or `selectVisibleThreadKeys(state, Date.now())`, which apply snoozes and the filter.
 * - `folders[accountId]`, `accounts`, `openThread` (full `MailThread` with bodies),
 *   `selection`, `focused`, `undo` (show `undo.label` with an Undo button),
 *   `error` (an allowlisted `MailError`, show `error.message` as text),
 *   `drafts` and `activeDraftId`.
 *
 * ## Actions (`MailStore`)
 *
 * - Lists: `openView({ kind: "unified", role: "inbox" } | { kind: "folder", accountId, folderId })`,
 *   `refresh()`, `loadMore()` (call near the end of the list while `selectHasMore`),
 *   `setFilter(text)` (instant, local), `search(text)` (provider, all accounts).
 * - Threads: `openThread(key)`, `closeThread()`.
 * - Selection: `focus`, `toggleSelect`, `selectRangeTo` (shift-click), `selectAllVisible`, `clearSelection`.
 * - Triage (optimistic, rolled back with an error on failure): `archive`, `trash`,
 *   `moveTo(folderId)`, `markRead(bool)`, `setFlag(bool)`, `snooze(untilIso)`,
 *   `unsnooze`, `undo`, `dismissUndo`. Without `keys` they act on the selection,
 *   else the focused thread.
 * - Drafts: `compose()`, `respond("reply" | "replyAll" | "forward")`,
 *   `editDraft(localId, { to, cc, bcc, subject, bodyText, bodyHtml, attachments })`
 *   (autosaves after `autosaveMs`), `closeDraft`, `openDraft`, `discardDraft`,
 *   `sendDraft` (only from an explicit Send click). `DraftState.draft` holds the
 *   owner's part; the quoted original is `DraftState.quote` (escaped text and
 *   HTML) and is appended on save. Show `quote.text` as text, never as HTML.
 * - Keyboard: `mailCommandForKey({ key, shiftKey, ctrlKey, metaKey, altKey,
 *   editable: isEditableTarget(event.target) })` then `store.runCommand(command)`;
 *   the result's `effect` asks the UI to focus search or show the composer.
 *   `MAIL_KEY_BINDINGS` lists the keys for a shortcut sheet.
 *
 * ## Derived lists
 *
 * `selectWaitingOnYou(state, now)` and `selectAwaitingThem(state, now)`,
 * `selectFolderTree(folders)`, `selectInboxUnread`, `selectTargetKeys`,
 * `selectOpenDrafts`, `selectActiveDraft`, `isDraftDirty`.
 *
 * ## Safety
 *
 * Every summary, name, subject and body is untrusted: render as text.
 * `openThread.thread.messages[].bodyHtml` is `UntrustedHtml` and must go
 * through the mail HTML sanitiser. Error text in state is always one of the
 * fixed sentences in `errors.ts`.
 */
export { createMailStore, SNOOZE_CHECK_MS } from "./store";
export type { MailCommandEffect, MailCommandResult, MailStore } from "./store";
export {
  DEFAULT_AUTOSAVE_MS,
  DEFAULT_CACHE_FLUSH_MS,
  defaultMailCache,
} from "./store-core";
export type { MailAccountEntry, MailStoreOptions, MailTimers } from "./store-core";
export { MAX_OPEN_DRAFTS } from "./store-drafts";
export type { DraftEdit } from "./store-drafts";
export { triageLabel } from "./store-triage";
export type { ProviderTriageKind, TriageOptions } from "./store-triage";

export * from "./types";
export { UNIFIED_INBOX, threadKey, viewKeyOf } from "./ids";
export type { ThreadKey, UnifiedRole, ViewDescriptor, ViewKey } from "./ids";
export {
  MAIL_LOCAL_ERROR_MESSAGES,
  isAllowedMailErrorMessage,
  localMailError,
  toMailError,
} from "./errors";
export type { MailError, MailErrorCode, MailLocalErrorCode, MailLogger } from "./errors";
export {
  MAX_QUERY_CHARS,
  emptyMailQuery,
  isEmptyQuery,
  matchesQuery,
  parseMailQuery,
  toProviderQuery,
} from "./query";
export type { MailQuery } from "./query";
export {
  DAY_MS,
  WAITING_WINDOW_MS,
  hidesSnoozed,
  isDraftDirty,
  selectActiveDraft,
  selectActiveView,
  selectAwaitingThem,
  selectFocusedSummary,
  selectFolderTree,
  selectHasMore,
  selectInboxUnread,
  selectIsTriagePending,
  selectOpenDrafts,
  selectTargetKeys,
  selectVisibleThreadKeys,
  selectWaitingOnYou,
  waitingState,
} from "./selectors";
export type { FolderNode } from "./selectors";
export {
  MAX_QUOTED_CHARS,
  buildDraftFromThread,
  composeDraft,
  forwardSubject,
  replyMetaFromThread,
  replySubject,
} from "./drafts";
export type { BuildDraftOptions, BuiltDraft } from "./drafts";
export { MAIL_KEY_BINDINGS, isEditableTarget, mailCommandForKey } from "./keyboard";
export type { MailCommand, MailKeyBinding, MailKeyInput } from "./keyboard";
export {
  MAIL_CACHE_TABLES,
  MAX_CACHED_THREADS,
  createDbMailCache,
  noMailCache,
} from "./cache";
export type { MailCache, MailCacheDb } from "./cache";
export { MAX_THREADS_IN_MEMORY, hasMorePages, initialMailState } from "./reducers";
