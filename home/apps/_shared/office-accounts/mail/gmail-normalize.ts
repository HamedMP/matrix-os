/**
 * Raw Gmail API JSON to the provider-neutral mail shapes. Pure functions.
 *
 * Label roles: INBOX, SENT, DRAFT, TRASH, SPAM and STARRED are the standard
 * folders. Archive is virtual: Gmail archives by removing INBOX, so it is
 * listed with a search and can never be the target of a label change. User
 * labels nest by `/` in their names.
 */
import {
  instantFromMs, untrustedHtml,
  type IsoInstant, type MailAddress, type MailAttachment, type MailFolder, type MailFolderRole, type MailMessage, type ThreadSummary,
} from "../types/mail.js";
import { parseAddress, parseAddressList, uniqueAddresses } from "./addresses.js";
import { asArray, asNumber, asRecord, asString } from "./bridge.js";
import { cleanContentId, decodeBase64Text, decodeEncodedWords, decodeEntities, htmlToText, oneLine } from "./text.js";

/** Id of the computed archive folder. It cannot match a Gmail label id, so it is never sent to Gmail. */
export const GMAIL_ARCHIVE_ID = "virtual.archive";
/** Search that lists the archive: everything outside the inbox, spam and trash. */
export const GMAIL_ARCHIVE_QUERY = "-in:inbox -in:spam -in:trash";

const SYSTEM_ROLES: Readonly<Record<string, Exclude<MailFolderRole, "custom" | "archive">>> = {
  INBOX: "inbox", SENT: "sent", DRAFT: "drafts", TRASH: "trash", SPAM: "spam", STARRED: "starred",
};
const SYSTEM_NAMES: Readonly<Record<string, string>> = {
  INBOX: "Inbox", SENT: "Sent", DRAFT: "Drafts", TRASH: "Trash", SPAM: "Spam", STARRED: "Starred",
};
const ROLE_ORDER: readonly MailFolderRole[] = ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash"];
/** Labels that describe state, not a place; they never appear in `folderIds`. */
const STATE_LABELS = new Set(["UNREAD", "IMPORTANT", "CHAT"]);

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  labelListVisibility?: string;
  threadsUnread?: number;
}

export function readGmailLabels(data: unknown): GmailLabel[] {
  return asArray(asRecord(data).labels).map(asRecord).flatMap((label) => {
    const id = asString(label.id);
    const name = asString(label.name);
    if (!id || !name) return [];
    return [{
      id, name, type: asString(label.type) || undefined, labelListVisibility: asString(label.labelListVisibility) || undefined,
      threadsUnread: asNumber(label.threadsUnread),
    }];
  });
}

/** Folders for a label list: the standard roles, the virtual archive, then user labels with nesting. */
export function gmailFoldersFromLabels(labels: readonly GmailLabel[], inboxUnread?: number): MailFolder[] {
  const roleFolders: MailFolder[] = [];
  for (const label of labels) {
    const role = SYSTEM_ROLES[label.id];
    if (!role) continue;
    const folder: MailFolder = { id: label.id, name: SYSTEM_NAMES[label.id], role };
    if (label.id === "INBOX" && inboxUnread !== undefined) folder.unreadCount = inboxUnread;
    roleFolders.push(folder);
  }
  if (roleFolders.some((folder) => folder.role === "inbox")) {
    roleFolders.push({ id: GMAIL_ARCHIVE_ID, name: "Archive", role: "archive", virtual: true });
  }
  roleFolders.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  const userLabels = labels
    .filter((label) => label.type === "user" && label.labelListVisibility !== "labelHide")
    .sort((a, b) => a.name.localeCompare(b.name));
  const idByName = new Map(userLabels.map((label) => [label.name, label.id]));
  const custom = userLabels.map((label): MailFolder => {
    const slash = label.name.lastIndexOf("/");
    const folder: MailFolder = { id: label.id, name: slash === -1 ? label.name : label.name.slice(slash + 1), role: "custom" };
    const parentId = slash === -1 ? undefined : idByName.get(label.name.slice(0, slash));
    if (parentId) folder.parentId = parentId;
    if (label.threadsUnread !== undefined) folder.unreadCount = label.threadsUnread;
    return folder;
  });
  return [...roleFolders, ...custom];
}

/** The place labels of a message: its labels without state labels and inbox categories. */
export function gmailFolderIds(labelIds: readonly string[]): string[] {
  return labelIds.filter((id) => !STATE_LABELS.has(id) && !id.startsWith("CATEGORY_"));
}

interface GmailPart {
  mimeType: string;
  filename: string;
  headers: Map<string, string>;
  size: number;
  data?: string;
  attachmentId?: string;
  parts: unknown[];
}

const MAX_PART_DEPTH = 20;
const MAX_PARTS = 500;

function readPart(value: unknown): GmailPart {
  const part = asRecord(value);
  const headers = new Map<string, string>();
  for (const header of asArray(part.headers).map(asRecord)) {
    const name = asString(header.name).toLowerCase();
    if (name && !headers.has(name)) headers.set(name, asString(header.value));
  }
  const body = asRecord(part.body);
  return {
    mimeType: asString(part.mimeType).toLowerCase(),
    filename: asString(part.filename),
    headers,
    size: asNumber(body.size) ?? 0,
    data: asString(body.data) || undefined,
    attachmentId: asString(body.attachmentId) || undefined,
    parts: asArray(part.parts),
  };
}

/** Depth-first parts of a payload, the payload itself first, bounded in depth and count. */
function walkParts(payload: unknown): GmailPart[] {
  const out: GmailPart[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_PART_DEPTH || out.length >= MAX_PARTS) return;
    const part = readPart(value);
    out.push(part);
    for (const child of part.parts) visit(child, depth + 1);
  };
  visit(payload, 0);
  return out;
}

function charsetOf(part: GmailPart): string | undefined {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(part.headers.get("content-type") ?? "");
  return match?.[1];
}

function isAttachmentPart(part: GmailPart): boolean {
  return part.filename !== "" || /^\s*attachment/i.test(part.headers.get("content-disposition") ?? "");
}

function decodePart(part: GmailPart): string | null {
  if (!part.data) return null;
  try {
    return decodeBase64Text(part.data, charsetOf(part));
  } catch (error: unknown) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function attachmentOf(part: GmailPart): MailAttachment | null {
  if (!part.attachmentId || !isAttachmentPart(part)) return null;
  const attachment: MailAttachment = {
    id: part.attachmentId,
    name: decodeEncodedWords(part.filename) || "attachment",
    mimeType: part.mimeType || "application/octet-stream",
    size: part.size,
  };
  if (/^\s*inline/i.test(part.headers.get("content-disposition") ?? "") || part.headers.has("content-id")) attachment.inline = true;
  const contentId = cleanContentId(part.headers.get("content-id")) ?? cleanContentId(part.headers.get("x-attachment-id"));
  if (contentId) attachment.contentId = contentId;
  return attachment;
}

/** Message ids in angle brackets from a `References` or `In-Reply-To` value. */
export function parseMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[^<>\s]{1,995}>/g)].map((match) => match[0]).slice(0, 200);
}

function instantOf(internalDate: unknown, dateHeader: string | undefined): IsoInstant {
  const ms = asNumber(internalDate);
  if (ms !== undefined) return instantFromMs(ms);
  const parsed = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(parsed) ? instantFromMs(parsed) : instantFromMs(0);
}

/** A full Gmail message (`format=full`) as a `MailMessage`. */
export function normalizeGmailMessage(raw: unknown): MailMessage {
  const message = asRecord(raw);
  const parts = walkParts(message.payload);
  const headers = parts[0]?.headers ?? new Map<string, string>();
  const labelIds = asArray(message.labelIds).map(asString);
  let text: string | null = null;
  let html: string | null = null;
  const attachments: MailAttachment[] = [];
  for (const part of parts) {
    const attachment = attachmentOf(part);
    if (attachment) { attachments.push(attachment); continue; }
    if (isAttachmentPart(part)) continue;
    if (text === null && part.mimeType === "text/plain") text = decodePart(part);
    else if (html === null && part.mimeType === "text/html") html = decodePart(part);
  }
  const messageIdHeader = parseMessageIds(headers.get("message-id"))[0] ?? null;
  const result: MailMessage = {
    id: asString(message.id),
    threadId: asString(message.threadId),
    from: parseAddress(headers.get("from")),
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    bcc: parseAddressList(headers.get("bcc")),
    sentAt: instantOf(message.internalDate, headers.get("date")),
    subject: decodeEncodedWords(headers.get("subject") ?? ""),
    bodyText: text ?? (html !== null ? htmlToText(html) : decodeEntities(asString(message.snippet))),
    bodyHtml: html !== null ? untrustedHtml(html) : null,
    attachments,
    messageIdHeader,
    references: parseMessageIds(headers.get("references")),
    unread: labelIds.includes("UNREAD"),
  };
  const replyTo = parseAddressList(headers.get("reply-to"));
  if (replyTo.length) result.replyTo = replyTo;
  return result;
}

/** Ids of every message in a Gmail thread reply. */
export function gmailThreadMessageIds(raw: unknown): string[] {
  return asArray(asRecord(raw).messages).map((message) => asString(asRecord(message).id)).filter(Boolean);
}

/** Label ids of every message in a thread reply, by message id. */
export function gmailThreadLabels(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const message of asArray(asRecord(raw).messages).map(asRecord)) {
    out.set(asString(message.id), asArray(message.labelIds).map(asString));
  }
  return out;
}

/** A thread reply (`format=summary` or `full`) as a `ThreadSummary`. */
export function summarizeGmailThread(raw: unknown, accountId: string): ThreadSummary {
  const thread = asRecord(raw);
  const messages = asArray(thread.messages).map(asRecord);
  const senders: MailAddress[] = [];
  const recipients: MailAddress[] = [];
  const folderIds = new Set<string>();
  let subject = "";
  let lastMs = 0;
  let unread = false;
  let flagged = false;
  let hasAttachments = false;
  let snippet = "";
  for (const message of messages) {
    const parts = walkParts(message.payload);
    const headers = parts[0]?.headers ?? new Map<string, string>();
    const labelIds = asArray(message.labelIds).map(asString);
    if (!subject) subject = decodeEncodedWords(headers.get("subject") ?? "");
    senders.push(parseAddress(headers.get("from")));
    recipients.push(...parseAddressList(headers.get("to")), ...parseAddressList(headers.get("cc")));
    for (const id of gmailFolderIds(labelIds)) folderIds.add(id);
    unread ||= labelIds.includes("UNREAD");
    flagged ||= labelIds.includes("STARRED");
    hasAttachments ||= parts.some((part) => {
      const attachment = attachmentOf(part);
      return attachment !== null && !attachment.inline;
    });
    const ms = asNumber(message.internalDate) ?? 0;
    if (ms >= lastMs) {
      lastMs = ms;
      snippet = asString(message.snippet);
    }
  }
  return {
    id: asString(thread.id),
    accountId,
    subject,
    snippet: oneLine(decodeEntities(snippet)),
    participants: uniqueAddresses([...senders, ...recipients]),
    lastMessageAt: instantFromMs(lastMs),
    unread,
    flagged,
    hasAttachments,
    folderIds: [...folderIds],
    messageCount: messages.length,
  };
}
