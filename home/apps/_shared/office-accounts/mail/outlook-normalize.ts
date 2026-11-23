/**
 * Raw Microsoft Graph mail JSON to the provider-neutral mail shapes. Pure functions.
 *
 * Outlook holds each message in exactly one folder. The standard folders are
 * found by their well-known names (never by translated display names), and
 * the starred view is virtual: it lists flagged messages of the inbox.
 * Threads are conversations, grouped by `conversationId`.
 */
import {
  compareInstants, instantFromMs, normalizeMailAddress, untrustedHtml,
  type IsoInstant, type MailAddress, type MailAttachment, type MailFolder, type MailFolderRole, type MailMessage, type ThreadSummary,
} from "../types/mail.js";
import { uniqueAddresses } from "./addresses.js";
import { asArray, asNumber, asRecord, asString } from "./bridge.js";
import { cleanContentId, decodeEntities, htmlToText, oneLine, stripControl } from "./text.js";

/** Id of the computed starred view. It contains a dot, so it is never a Graph id. */
export const OUTLOOK_STARRED_ID = "virtual.flagged";

/** Well-known folder names, in the order the folder list shows them. */
export const OUTLOOK_WELL_KNOWN: ReadonlyArray<readonly [string, Exclude<MailFolderRole, "custom" | "starred">]> = [
  ["inbox", "inbox"], ["sentitems", "sent"], ["drafts", "drafts"], ["archive", "archive"], ["junkemail", "spam"], ["deleteditems", "trash"],
];
const ROLE_NAMES: Readonly<Record<string, string>> = {
  inbox: "Inbox", sent: "Sent", drafts: "Drafts", archive: "Archive", spam: "Junk", trash: "Deleted",
};
const ROLE_ORDER: readonly MailFolderRole[] = ["inbox", "starred", "sent", "drafts", "archive", "spam", "trash"];

export interface GraphFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  unreadItemCount?: number;
}

export function readGraphFolder(value: unknown): GraphFolder | null {
  const folder = asRecord(value);
  const id = asString(folder.id);
  if (!id) return null;
  return {
    id,
    displayName: asString(folder.displayName),
    parentFolderId: asString(folder.parentFolderId) || undefined,
    unreadItemCount: asNumber(folder.unreadItemCount),
  };
}

/**
 * Folders from the listed mail folders plus the resolved well-known ones.
 * `wellKnown` maps a role to the folder `get_folder` returned for its name.
 */
export function outlookFolders(listed: readonly GraphFolder[], wellKnown: ReadonlyMap<MailFolderRole, GraphFolder>): MailFolder[] {
  const roleById = new Map<string, MailFolderRole>();
  for (const [role, folder] of wellKnown) roleById.set(folder.id, role);
  const all = new Map<string, GraphFolder>();
  for (const folder of [...wellKnown.values(), ...listed]) if (!all.has(folder.id)) all.set(folder.id, folder);

  const toFolder = (folder: GraphFolder, role: MailFolderRole): MailFolder => {
    const out: MailFolder = { id: folder.id, name: role === "custom" ? folder.displayName || "Folder" : ROLE_NAMES[role], role };
    if (folder.unreadItemCount !== undefined) out.unreadCount = folder.unreadItemCount;
    if (folder.parentFolderId && all.has(folder.parentFolderId)) out.parentId = folder.parentFolderId;
    return out;
  };
  const roleFolders: MailFolder[] = [];
  const custom: MailFolder[] = [];
  for (const folder of all.values()) {
    const role = roleById.get(folder.id);
    if (role) roleFolders.push(toFolder(folder, role));
    else custom.push(toFolder(folder, "custom"));
  }
  if (roleFolders.some((folder) => folder.role === "inbox")) {
    roleFolders.push({ id: OUTLOOK_STARRED_ID, name: "Flagged", role: "starred", virtual: true });
  }
  roleFolders.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  custom.sort((a, b) => a.name.localeCompare(b.name));
  return [...roleFolders, ...custom];
}

function graphAddress(value: unknown): MailAddress | null {
  const email = asRecord(asRecord(value).emailAddress);
  const address = normalizeMailAddress(asString(email.address));
  if (!address) return null;
  const name = stripControl(asString(email.name)).trim();
  return name && normalizeMailAddress(name) !== address ? { name, address } : { address };
}

export function graphAddresses(value: unknown): MailAddress[] {
  return asArray(value).slice(0, 500).map(graphAddress).filter((entry): entry is MailAddress => entry !== null);
}

function instantOf(value: unknown): IsoInstant {
  const ms = Date.parse(asString(value));
  return instantFromMs(Number.isFinite(ms) ? ms : 0);
}

/** A Graph message as the adapter keeps it between calls: enough to move, flag and summarise it. */
export interface GraphMessageRef {
  id: string;
  conversationId: string;
  parentFolderId: string;
  isRead: boolean;
  flagged: boolean;
  isDraft: boolean;
}

export function readGraphMessageRef(value: unknown): GraphMessageRef | null {
  const message = asRecord(value);
  const id = asString(message.id);
  if (!id) return null;
  return {
    id,
    conversationId: asString(message.conversationId),
    parentFolderId: asString(message.parentFolderId),
    isRead: message.isRead !== false,
    flagged: asString(asRecord(message.flag).flagStatus) === "flagged",
    isDraft: message.isDraft === true,
  };
}

/** A Graph message (summary or full select) as a `MailMessage`. Attachments are added separately. */
export function normalizeGraphMessage(raw: unknown, attachments: MailAttachment[] = []): MailMessage {
  const message = asRecord(raw);
  const body = asRecord(message.body);
  const content = asString(body.content);
  const isHtml = asString(body.contentType).toLowerCase() === "html";
  const internetId = asString(message.internetMessageId);
  const result: MailMessage = {
    id: asString(message.id),
    threadId: asString(message.conversationId),
    from: graphAddress(message.from) ?? graphAddress(message.sender) ?? { address: "" },
    to: graphAddresses(message.toRecipients),
    cc: graphAddresses(message.ccRecipients),
    bcc: graphAddresses(message.bccRecipients),
    sentAt: instantOf(message.sentDateTime || message.receivedDateTime),
    subject: asString(message.subject),
    bodyText: content ? (isHtml ? htmlToText(content) : content) : decodeEntities(asString(message.bodyPreview)),
    bodyHtml: content && isHtml ? untrustedHtml(content) : null,
    attachments,
    messageIdHeader: /^<[^<>\s]{1,995}>$/.test(internetId) ? internetId : null,
    references: [],
    unread: message.isRead === false,
  };
  if (message.isDraft === true && result.id) result.draftId = result.id;
  return result;
}

export function readGraphAttachments(data: unknown): Array<MailAttachment & { size: number }> {
  return asArray(asRecord(data).value).map(asRecord).flatMap((item) => {
    const id = asString(item.id);
    if (!id) return [];
    const attachment: MailAttachment = {
      id,
      name: asString(item.name) || "attachment",
      mimeType: asString(item.contentType) || "application/octet-stream",
      size: asNumber(item.size) ?? 0,
    };
    if (item.isInline === true) attachment.inline = true;
    const contentId = cleanContentId(item.contentId);
    if (contentId) attachment.contentId = contentId;
    return [attachment];
  });
}

function receivedMs(message: Record<string, unknown>): number {
  const ms = Date.parse(asString(message.receivedDateTime) || asString(message.sentDateTime));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Groups a page of Graph messages into conversations, newest first. Each
 * summary describes the messages seen on this page.
 */
export function summarizeGraphMessages(rawMessages: readonly unknown[], accountId: string): ThreadSummary[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const raw of rawMessages) {
    const message = asRecord(raw);
    const key = asString(message.conversationId) || asString(message.id);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  const summaries: ThreadSummary[] = [];
  for (const [id, messages] of groups) {
    const ordered = [...messages].sort((a, b) => receivedMs(b) - receivedMs(a));
    const latest = ordered[0];
    const senders = ordered.map((message) => graphAddress(message.from)).filter((entry): entry is MailAddress => entry !== null);
    const recipients = ordered.flatMap((message) => [...graphAddresses(message.toRecipients), ...graphAddresses(message.ccRecipients)]);
    summaries.push({
      id,
      accountId,
      subject: asString(latest.subject),
      snippet: oneLine(decodeEntities(asString(latest.bodyPreview))),
      participants: uniqueAddresses([...senders, ...recipients]),
      lastMessageAt: instantFromMs(receivedMs(latest)),
      unread: ordered.some((message) => message.isRead === false),
      flagged: ordered.some((message) => asString(asRecord(message.flag).flagStatus) === "flagged"),
      hasAttachments: ordered.some((message) => message.hasAttachments === true),
      folderIds: [...new Set(ordered.map((message) => asString(message.parentFolderId)).filter(Boolean))],
      messageCount: ordered.length,
    });
  }
  return summaries.sort((a, b) => compareInstants(b.lastMessageAt, a.lastMessageAt));
}

/** The `$skiptoken` value of an `@odata.nextLink`, or null. */
export function graphSkipToken(data: unknown): string | null {
  const link = asString(asRecord(data)["@odata.nextLink"]);
  if (!link) return null;
  try {
    const token = new URL(link).searchParams.get("$skiptoken");
    return token && token.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(token) ? token : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
