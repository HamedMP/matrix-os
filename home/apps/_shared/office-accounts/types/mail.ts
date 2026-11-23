/**
 * Provider-neutral mail contract for the Mail app.
 *
 * The Mail app and the agent's mail tools talk to a `MailProvider`. One adapter
 * per provider (Gmail, Outlook) turns these shapes into integration actions; the
 * action list is in `specs/2710-office-mail-suite/integration-actions.md`.
 *
 * Everything that comes from a mailbox is untrusted: subjects, snippets, names,
 * addresses, bodies and attachment names. Render text as text, and pass HTML
 * through the sanitiser before it reaches the document.
 */
import { ProviderError, type ProviderErrorCode } from "./errors.js";
import type { IsoInstant } from "./time.js";

export * from "./errors.js";
export * from "./time.js";

export type MailProviderId = "gmail" | "outlook";

/** The integration service that serves each mail provider. */
export const MAIL_SERVICE_IDS: Readonly<Record<MailProviderId, string>> = Object.freeze({
  gmail: "gmail",
  outlook: "microsoft_outlook",
});

export interface MailAccount {
  /** Stable and opaque. Build it with `mailAccountId`. */
  id: string;
  provider: MailProviderId;
  /** The mailbox address, lower-cased. */
  address: string;
  /** Owner-facing name; falls back to the address. */
  displayName: string;
}

export const MAIL_FOLDER_ROLES = ["inbox", "sent", "drafts", "archive", "trash", "spam", "starred", "custom"] as const;
export type MailFolderRole = (typeof MAIL_FOLDER_ROLES)[number];

/**
 * A place threads are listed from. Gmail labels and Outlook folders both map
 * here. Each adapter returns at most one folder for every role except `custom`.
 */
export interface MailFolder {
  id: string;
  name: string;
  role: MailFolderRole;
  unreadCount?: number;
  /** Set for a nested folder or label. */
  parentId?: string;
  /**
   * True when the folder is a view the adapter computes, not a container: it
   * can be listed but must not appear in `ThreadChange.addFolders` or
   * `removeFolders`. Gmail's archive and Outlook's starred view are virtual.
   */
  virtual?: boolean;
}

export interface MailAddress {
  name?: string;
  address: string;
}

export interface ThreadSummary {
  id: string;
  accountId: string;
  subject: string;
  /** Plain text, one line, already truncated by the provider or the adapter. */
  snippet: string;
  /** Everyone on the thread, senders first, without duplicates. */
  participants: MailAddress[];
  lastMessageAt: IsoInstant;
  /** True when at least one message is unread. */
  unread: boolean;
  /** True when at least one message is starred or flagged. */
  flagged: boolean;
  hasAttachments: boolean;
  /** Ids of the non-virtual folders that hold at least one message of the thread. */
  folderIds: string[];
  messageCount: number;
}

declare const untrustedHtmlBrand: unique symbol;

/**
 * HTML exactly as the provider returned it: unsanitised and hostile until
 * proven otherwise. It may contain scripts, forms, event handlers, remote
 * images and tracking links. The only legitimate consumer is the mail HTML
 * sanitiser. Never assign it to `innerHTML`, `srcdoc` or
 * `dangerouslySetInnerHTML`, and never hand it to the agent unwrapped.
 */
export type UntrustedHtml = string & { readonly [untrustedHtmlBrand]: true };

/** Marks provider HTML as untrusted. Adapters call this; it does not change the text. */
export function untrustedHtml(raw: string): UntrustedHtml {
  return raw as UntrustedHtml;
}

export interface MailAttachment {
  /** Opaque; pass it to `getAttachment` together with the message id. */
  id: string;
  name: string;
  mimeType: string;
  /** Decoded size in bytes. */
  size: number;
  /** True for an image referenced from the body rather than a listed file. */
  inline?: boolean;
  /** The part's Content-ID without angle brackets; a body refers to it as `cid:<contentId>`. */
  contentId?: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  from: MailAddress;
  /** The `Reply-To` addresses; replies go here instead of `from`. Absent or empty when the sender set none. */
  replyTo?: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  sentAt: IsoInstant;
  subject: string;
  /** Plain-text body; derived from the HTML when the provider has no text part. */
  bodyText: string;
  /** Unsanitised provider HTML, or null when the message has only plain text. */
  bodyHtml: UntrustedHtml | null;
  attachments: MailAttachment[];
  /** The RFC 5322 `Message-ID` header including angle brackets, or null if unknown. */
  messageIdHeader: string | null;
  /** The `References` header as a list of message ids, oldest first. Empty if unknown. */
  references: string[];
  unread?: boolean;
  /** Set when this message is an unsent draft; pass it to `sendDraft` or `saveDraft`. */
  draftId?: string;
}

/** One conversation with its messages, oldest first. */
export interface MailThread {
  id: string;
  accountId: string;
  subject: string;
  folderIds: string[];
  messages: MailMessage[];
}

export interface DraftAttachment {
  /** Set once the provider has stored the attachment. */
  id?: string;
  name: string;
  mimeType: string;
  /** Decoded size in bytes. */
  size: number;
  /** Standard base64 (not URL-safe), with padding. Required until `id` is set. */
  contentBase64?: string;
}

export interface Draft {
  /** Absent for a draft the provider has not stored yet. */
  id?: string;
  /** The thread a reply belongs to. */
  threadId?: string;
  /** The message being answered; adapters derive reply headers from it. */
  inReplyToMessageId?: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** Owner-authored HTML. Quoted provider content must be sanitised before it is placed here. */
  bodyHtml: string;
  bodyText: string;
  attachments: DraftAttachment[];
}

export interface Page<T> {
  items: T[];
  /** Opaque. Null when there are no further pages. */
  nextCursor: string | null;
}

export interface ListThreadsRequest {
  folderId: string;
  /** Provider search syntax, applied inside the folder. */
  query?: string;
  cursor?: string;
  /** 1 to `MAIL_PAGE_MAX`; see `clampPageLimit`. */
  limit: number;
}

/**
 * Move, archive, trash, mark read and flag, expressed one way for every
 * provider. Build folder changes with `archiveChange`, `trashChange` and
 * `moveChange`.
 *
 * - Label providers (Gmail) apply `addFolders` and `removeFolders` as given.
 * - Folder providers (Outlook) hold a message in exactly one folder: they move
 *   the messages that sit in a `removeFolders` folder (every message of the
 *   thread when `removeFolders` is empty) to `addFolders[0]`. A change with
 *   only `removeFolders` is `not_supported` there.
 * - `restore` marks the undo of an earlier change. Folder providers move each
 *   message that change moved back to the folder it came from; when they no
 *   longer know where a message came from they fall back to the rule above.
 *   Label providers ignore it.
 * - A virtual folder id in either list is `not_supported`.
 * - Starring is `flagged`, never the starred folder.
 * - Nothing here deletes permanently. Trash is a move to the trash folder.
 */
export interface ThreadChange {
  addFolders?: string[];
  removeFolders?: string[];
  restore?: boolean;
  read?: boolean;
  flagged?: boolean;
}

export interface AttachmentContent {
  name: string;
  mimeType: string;
  /** Decoded size in bytes. */
  size: number;
  /** Standard base64 (not URL-safe), with padding. Untrusted file content. */
  contentBase64: string;
  /** The Content-ID without angle brackets, when the provider returns it with the content. */
  contentId?: string;
}

/**
 * Every method rejects with a `ProviderError`. No method retries on its own,
 * and none sends mail except `sendDraft`.
 */
export interface MailProvider {
  listFolders(): Promise<MailFolder[]>;
  /** Newest thread first. */
  listThreads(request: ListThreadsRequest): Promise<Page<ThreadSummary>>;
  getThread(id: string): Promise<MailThread>;
  /** `query` is the owner's text in the provider's own search syntax, across all folders. */
  search(query: string, cursor?: string): Promise<Page<ThreadSummary>>;
  /** Applies one change to every message of each thread. At most `MAX_MODIFY_THREADS` ids. */
  modifyThreads(ids: string[], change: ThreadChange): Promise<void>;
  /** Creates the draft when `draft.id` is absent, otherwise replaces it. Returns it with its id. */
  saveDraft(draft: Draft): Promise<Draft>;
  /** Discards an unsent draft. Absent when the provider cannot. */
  deleteDraft?(draftId: string): Promise<void>;
  /**
   * Sends a stored draft. Call this only from an explicit owner click on Send
   * (or an owner-approved agent tool call). Never call it from an effect, a
   * retry loop, a timer or a background task.
   */
  sendDraft(draftId: string): Promise<void>;
  getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent>;
  /**
   * The owner's most recent sent messages to one address, newest first, at most
   * `MAX_SENT_SAMPLES`. Used to learn the owner's writing voice for drafts.
   */
  listSentTo(address: string, limit: number): Promise<MailMessage[]>;
}

export const MAIL_PAGE_DEFAULT = 25;
export const MAIL_PAGE_MAX = 50;
export const MAX_MODIFY_THREADS = 100;
export const MAX_SENT_SAMPLES = 20;
export const MAX_REPLY_REFERENCES = 20;
export const MAX_DRAFT_RECIPIENTS = 100;
export const MAX_DRAFT_ATTACHMENTS = 10;
export const MAX_DRAFT_SUBJECT_CHARS = 255;
/**
 * A draft travels to the gateway as one JSON request, and that request is
 * limited to 64 KiB end to end. This is the budget for the draft itself
 * (recipients, subject, both bodies and base64 attachment content together).
 */
export const MAX_DRAFT_REQUEST_BYTES = 60_000;
/** Largest attachment the read path returns, in decoded bytes. */
export const MAX_ATTACHMENT_READ_BYTES = 1024 * 1024;

const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

export function normalizeMailAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function sameMailAddress(a: string, b: string): boolean {
  return normalizeMailAddress(a) === normalizeMailAddress(b);
}

/** A deliberately strict check: one address, no display name, no whitespace, at most 254 characters. */
export function isValidMailAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}

export function mailAccountId(provider: MailProviderId, address: string): string {
  return `${provider}:${normalizeMailAddress(address)}`;
}

/** `Name <address>` for display and for plain-text quoting. Line breaks are removed. */
export function formatMailAddress(value: MailAddress): string {
  const address = value.address.replace(/[\r\n]+/g, "").trim();
  const name = (value.name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!name || name === address) return address;
  const quoted = /[",<>()@;:\\[\]]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${quoted} <${address}>`;
}

export function findFolder(folders: readonly MailFolder[], role: Exclude<MailFolderRole, "custom">): MailFolder | undefined {
  return folders.find((folder) => folder.role === role);
}

/** Leave the inbox; also enter the archive folder when the provider has a real one. */
export function archiveChange(folders: readonly MailFolder[]): ThreadChange {
  const inbox = findFolder(folders, "inbox");
  const archive = findFolder(folders, "archive");
  if (!inbox || !archive) throw new ProviderError("not_supported");
  return archive.virtual ? { removeFolders: [inbox.id] } : { removeFolders: [inbox.id], addFolders: [archive.id] };
}

/** Move to trash, which the owner can still recover from. Never a permanent delete. */
export function trashChange(folders: readonly MailFolder[], fromFolderId?: string): ThreadChange {
  const trash = findFolder(folders, "trash");
  if (!trash) throw new ProviderError("not_supported");
  return fromFolderId === undefined || fromFolderId === trash.id
    ? { addFolders: [trash.id] }
    : { addFolders: [trash.id], removeFolders: [fromFolderId] };
}

export function moveChange(fromFolderId: string, toFolderId: string): ThreadChange {
  if (!fromFolderId || !toFolderId || fromFolderId === toFolderId) {
    throw new RangeError("A move needs two different folders");
  }
  return { addFolders: [toFolderId], removeFolders: [fromFolderId] };
}

export function isEmptyThreadChange(change: ThreadChange): boolean {
  return !change.addFolders?.length && !change.removeFolders?.length
    && change.read === undefined && change.flagged === undefined;
}

/**
 * Headers for a reply to `message`: `In-Reply-To` is its message id, and
 * `References` is its own chain plus that id. Long chains keep the thread root
 * and the most recent ids.
 */
export function replyHeaders(message: Pick<MailMessage, "messageIdHeader" | "references">): { inReplyTo: string | null; references: string[] } {
  const chain = [...new Set([...message.references, ...(message.messageIdHeader ? [message.messageIdHeader] : [])])];
  const references = chain.length > MAX_REPLY_REFERENCES
    ? [chain[0], ...chain.slice(chain.length - (MAX_REPLY_REFERENCES - 1))]
    : chain;
  return { inReplyTo: message.messageIdHeader, references };
}

export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAIL_PAGE_DEFAULT;
  return Math.min(MAIL_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/** Decoded size of standard or URL-safe base64, without decoding it. */
export function base64DecodedBytes(base64: string): number {
  const length = base64.replace(/=+$/, "").length;
  return Math.floor((length * 3) / 4);
}

export function emptyDraft(): Draft {
  return { to: [], cc: [], bcc: [], subject: "", bodyHtml: "", bodyText: "", attachments: [] };
}

/**
 * A save that needs several provider calls failed after the provider had
 * already stored the draft. `draft` is what the provider now holds: its id,
 * and attachments with an `id` where they were stored (the rest keep their
 * content). The caller must keep that id so the next save updates this draft
 * instead of creating another copy.
 */
export class DraftPartiallySavedError extends ProviderError {
  readonly draft: Draft & { id: string };

  constructor(code: ProviderErrorCode, draft: Draft & { id: string }) {
    super(code);
    this.name = "DraftPartiallySavedError";
    this.draft = draft;
  }
}

/** The draft a failed save left at the provider, or undefined when the failure stored nothing. */
export function partiallySavedDraft(error: unknown): (Draft & { id: string }) | undefined {
  return error instanceof DraftPartiallySavedError ? error.draft : undefined;
}

export type DraftIssue =
  | "no_recipients"
  | "invalid_address"
  | "too_many_recipients"
  | "subject_too_long"
  | "too_many_attachments"
  | "too_large";

/** Bytes this draft occupies in the request that carries it to the gateway. */
export function draftRequestBytes(draft: Draft): number {
  const recipients = (list: MailAddress[]) => list.map(({ address, name }) => ({ address, name }));
  return new TextEncoder().encode(JSON.stringify({
    to: recipients(draft.to), cc: recipients(draft.cc), bcc: recipients(draft.bcc),
    subject: draft.subject, bodyHtml: draft.bodyHtml, bodyText: draft.bodyText,
    attachments: draft.attachments.map(({ name, mimeType, contentBase64 }) => ({ filename: name, mimeType, contentBase64 })),
  })).length;
}

/**
 * Problems that would make the gateway reject the draft, found before any
 * provider call. An empty list means the draft can be saved; with `forSend` it
 * also means it can be sent.
 */
export function draftIssues(draft: Draft, options: { forSend?: boolean } = {}): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  if (options.forSend && recipients.length === 0) issues.push("no_recipients");
  if (recipients.some((recipient) => !isValidMailAddress(recipient.address))) issues.push("invalid_address");
  if (recipients.length > MAX_DRAFT_RECIPIENTS) issues.push("too_many_recipients");
  if (draft.subject.length > MAX_DRAFT_SUBJECT_CHARS) issues.push("subject_too_long");
  if (draft.attachments.length > MAX_DRAFT_ATTACHMENTS) issues.push("too_many_attachments");
  if (draftRequestBytes(draft) > MAX_DRAFT_REQUEST_BYTES) issues.push("too_large");
  return issues;
}
