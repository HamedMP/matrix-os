/**
 * The Mail store's state. Everything here is serialisable (arrays, records and
 * plain values), so it works with `useSyncExternalStore`, structured clone and
 * snapshot tests.
 */
import type {
  Draft,
  DraftIssue,
  IsoInstant,
  MailAccount,
  MailFolder,
  MailThread,
  ThreadChange,
  ThreadSummary,
} from "../../../_shared/office-accounts/types/mail";
import type { MailError } from "./errors";
import type { ThreadKey, ViewDescriptor, ViewKey } from "./ids";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface AccountState {
  account: MailAccount;
  foldersStatus: LoadStatus;
  foldersError: MailError | null;
}

/** One thread list: a folder, the unified inbox or a search. */
export interface ThreadView {
  key: ViewKey;
  descriptor: ViewDescriptor;
  /** Newest first. Keys index `MailState.threads`. */
  threadKeys: ThreadKey[];
  /**
   * Next-page cursor per account id. A missing entry means that account has
   * not been listed yet; null means it has no further pages.
   */
  cursors: Record<string, string | null>;
  status: LoadStatus;
  loadingMore: boolean;
  error: MailError | null;
  /** True while the list shows only cached data and a refresh is due. */
  fromCache: boolean;
  /** Epoch ms of the last successful provider listing, or null. */
  loadedAt: number | null;
}

/** What the store knows about who wrote last, learned from a full thread. */
export interface ReplyMeta {
  /** Lower-cased address of the last message's sender. */
  lastFrom: string;
  /** `sentAt` of the last message. Stale when it differs from the summary's `lastMessageAt`. */
  lastAt: IsoInstant;
  /** True when the owner's account sent the last message. */
  ownerSentLast: boolean;
}

export type TriageKind =
  | "archive"
  | "trash"
  | "move"
  | "markRead"
  | "markUnread"
  | "flag"
  | "unflag"
  | "snooze"
  | "unsnooze"
  | "undo";

/** One per-thread provider change. */
export interface ThreadChangeItem {
  key: ThreadKey;
  change: ThreadChange;
}

/** An optimistic triage operation waiting for the provider. */
export interface PendingTriage {
  id: string;
  kind: TriageKind;
  changes: ThreadChangeItem[];
  /** Summaries before the change, for rollback and undo. */
  before: Record<ThreadKey, ThreadSummary>;
}

/** How to reverse the last finished triage action. */
export interface UndoEntry {
  kind: TriageKind;
  /** Owner-facing, e.g. "Archived 3 conversations". */
  label: string;
  changes: ThreadChangeItem[];
  /** Snooze state to restore: thread key to previous wake time, or null for "not snoozed". */
  snoozes: Record<ThreadKey, IsoInstant | null>;
  at: number;
}

export interface OpenThreadState {
  key: ThreadKey;
  status: LoadStatus;
  thread: MailThread | null;
  error: MailError | null;
}

export type DraftKind = "new" | "reply" | "replyAll" | "forward";

export interface DraftState {
  localId: string;
  accountId: string;
  kind: DraftKind;
  sourceThreadKey: ThreadKey | null;
  draft: Draft;
  /** Increases with every local edit. */
  revision: number;
  /** The revision the provider holds, 0 before the first save. */
  savedRevision: number;
  saving: boolean;
  sending: boolean;
  /** False once the owner navigated away; a closed draft is never reopened by the store. */
  open: boolean;
  issues: DraftIssue[];
  error: MailError | null;
  savedAt: number | null;
}

export interface SelectionState {
  keys: ThreadKey[];
  /** Where a shift-select range starts. */
  anchor: ThreadKey | null;
}

export interface MailState {
  accounts: AccountState[];
  /** Folders per account id. */
  folders: Record<string, MailFolder[]>;
  /** Every known summary, from the cache or the provider. */
  threads: Record<ThreadKey, ThreadSummary>;
  replyMeta: Record<ThreadKey, ReplyMeta>;
  /** Local snoozes: thread key to wake-up instant. */
  snoozed: Record<ThreadKey, IsoInstant>;
  views: Record<ViewKey, ThreadView>;
  activeView: ViewKey;
  /** Instant filter over the active list, in the query language of `query.ts`. */
  filter: string;
  focused: ThreadKey | null;
  selection: SelectionState;
  openThread: OpenThreadState | null;
  pending: PendingTriage[];
  undo: UndoEntry | null;
  /** The latest failure to show in a banner or toast. */
  error: MailError | null;
  drafts: Record<string, DraftState>;
  activeDraftId: string | null;
  /** True once cached data has been painted (or the cache was found empty). */
  cacheLoaded: boolean;
}
