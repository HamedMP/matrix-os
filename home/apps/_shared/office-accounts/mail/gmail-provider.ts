/**
 * `MailProvider` for Gmail, over the `gmail` integration actions listed in
 * specs/2710-office-mail-suite/integration-actions.md (sections 5 and 9).
 */
import {
  MAIL_PAGE_DEFAULT, MAX_ATTACHMENT_READ_BYTES, MAX_MODIFY_THREADS, MAX_SENT_SAMPLES,
  ProviderError, base64DecodedBytes, clampPageLimit, compareInstants, isEmptyThreadChange, isValidMailAddress,
  normalizeMailAddress, replyHeaders, toProviderError,
  type AttachmentContent, type Draft, type ListThreadsRequest, type MailFolder, type MailMessage, type MailProvider,
  type MailThread, type Page, type ThreadChange, type ThreadSummary,
} from "../types/mail.js";
import { asArray, asNumber, asRecord, asString, createServiceCaller, type ServiceCaller } from "./bridge.js";
import {
  AttachmentContentStore, assertDraftSavable, draftHtml, draftText, newAttachmentId, wireFilename, wireMimeType,
  wireRecipients, wireSubject,
} from "./drafts.js";
import {
  GMAIL_ARCHIVE_ID, GMAIL_ARCHIVE_QUERY, gmailFolderIds, gmailFoldersFromLabels, gmailThreadLabels, gmailThreadMessageIds,
  normalizeGmailMessage, readGmailLabels, summarizeGmailThread,
} from "./gmail-normalize.js";
import { createMessageCache, type MailAdapterOptions } from "./provider-options.js";
import {
  GMAIL_ATTACHMENT_ID_MAX, GMAIL_ID, GMAIL_ID_MAX, LruCache, decodeCursor, encodeCursor, mapLimit, requireId,
} from "./support.js";
import { base64UrlToBase64 } from "./text.js";

const SUMMARY_PARALLEL = 6;
const MESSAGE_PARALLEL = 4;
const BATCH_MODIFY_MAX = 100;
const MAX_LABEL_CHANGES = 20;
const MAX_QUERY_CHARS = 3800;
const CURSOR_KIND = "g";
const PROVIDER_OWNED_LABELS = new Set(["DRAFT", "SENT"]);

const gmailId = (value: unknown) => requireId(value, GMAIL_ID, GMAIL_ID_MAX);

function checkQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length > MAX_QUERY_CHARS) throw new ProviderError("not_supported", "The search is too long.");
  return trimmed;
}

export function createGmailProvider(options: MailAdapterOptions): MailProvider {
  const { account } = options;
  const caller: ServiceCaller = createServiceCaller(options.bridge, "gmail", options.label);
  const messages = createMessageCache();
  const threadMessageIds = new LruCache<string, string[]>(500);
  const attachmentContent = new AttachmentContentStore();

  async function fetchMessage(messageId: string): Promise<MailMessage> {
    const cached = messages.get(messageId);
    if (cached) return cached;
    const message = normalizeGmailMessage(await caller.read("get_message", { messageId }));
    messages.set(messageId, message);
    return message;
  }

  async function threadPage(params: { query?: string; labelIds?: string[] }, cursor: string | undefined, limit: number): Promise<Page<ThreadSummary>> {
    const token = decodeCursor(cursor, [CURSOR_KIND]);
    const data = asRecord(await caller.read("list_threads_query", {
      ...(params.query ? { query: params.query } : {}),
      ...(params.labelIds ? { labelIds: params.labelIds } : {}),
      maxResults: limit,
      ...(token ? { pageToken: token.value } : {}),
    }));
    const ids = asArray(data.threads).map((thread) => asString(asRecord(thread).id))
      .filter((id) => GMAIL_ID.test(id) && id.length <= GMAIL_ID_MAX);
    const items = await mapLimit(ids, SUMMARY_PARALLEL, async (threadId) => {
      const thread = await caller.read("get_thread", { threadId, format: "summary" });
      threadMessageIds.set(threadId, gmailThreadMessageIds(thread));
      return summarizeGmailThread(thread, account.id);
    });
    items.sort((a, b) => compareInstants(b.lastMessageAt, a.lastMessageAt));
    const next = asString(data.nextPageToken);
    return { items, nextCursor: next ? encodeCursor(CURSOR_KIND, next) : null };
  }

  async function draftIdsByMessage(): Promise<Map<string, string>> {
    const data = asRecord(await caller.read("list_drafts", { maxResults: 100 }));
    const out = new Map<string, string>();
    for (const draft of asArray(data.drafts).map(asRecord)) {
      const messageId = asString(asRecord(draft.message).id);
      if (messageId && asString(draft.id)) out.set(messageId, asString(draft.id));
    }
    return out;
  }

  async function loadThread(threadId: string): Promise<{ raw: unknown; list: MailMessage[] }> {
    try {
      const raw = await caller.read("get_thread", { threadId, format: "full" });
      const list = asArray(asRecord(raw).messages).map(normalizeGmailMessage);
      for (const message of list) messages.set(message.id, message);
      return { raw, list };
    } catch (error: unknown) {
      // A thread over the reply cap fails as a whole; fetch it message by message.
      const failure = toProviderError(error);
      if (failure.code !== "failed") throw failure;
      const raw = await caller.read("get_thread", { threadId, format: "summary" });
      const labels = gmailThreadLabels(raw);
      const list = await mapLimit(gmailThreadMessageIds(raw), MESSAGE_PARALLEL, async (messageId) => {
        const message = await fetchMessage(messageId);
        return { ...message, unread: (labels.get(messageId) ?? []).includes("UNREAD") };
      });
      return { raw, list };
    }
  }

  function labelChanges(change: ThreadChange): { add: string[]; remove: string[] } {
    const check = (id: string): string => {
      if (id === GMAIL_ARCHIVE_ID || PROVIDER_OWNED_LABELS.has(id)) throw new ProviderError("not_supported");
      return gmailId(id);
    };
    const add = new Set((change.addFolders ?? []).map(check));
    const remove = new Set((change.removeFolders ?? []).map(check));
    if (change.read === true) remove.add("UNREAD");
    if (change.read === false) add.add("UNREAD");
    if (change.flagged === true) add.add("STARRED");
    if (change.flagged === false) remove.add("STARRED");
    if ([...add].some((id) => remove.has(id)) || add.size > MAX_LABEL_CHANGES || remove.size > MAX_LABEL_CHANGES) {
      throw new ProviderError("not_supported");
    }
    return { add: [...add], remove: [...remove] };
  }

  async function replyContext(draft: Draft): Promise<{ threadId: string; inReplyTo: string; references: string[] } | null> {
    if (!draft.inReplyToMessageId) return null;
    const original = await fetchMessage(gmailId(draft.inReplyToMessageId));
    const headers = replyHeaders(original);
    if (!headers.inReplyTo) return null;
    return { threadId: gmailId(draft.threadId ?? original.threadId), inReplyTo: headers.inReplyTo, references: headers.references };
  }

  return {
    async listFolders(): Promise<MailFolder[]> {
      const [labels, inboxUnread] = await Promise.all([
        caller.read("list_labels"),
        caller.read("get_label", { labelId: "INBOX" }).then(
          (label) => asNumber(asRecord(label).threadsUnread),
          (error: unknown) => {
            // The unread count is decoration; the folder list stays usable without it.
            console.warn("[office-accounts] gmail inbox count unavailable", toProviderError(error).code);
            return undefined;
          },
        ),
      ]);
      return gmailFoldersFromLabels(readGmailLabels(labels), inboxUnread);
    },

    async listThreads(request: ListThreadsRequest): Promise<Page<ThreadSummary>> {
      const limit = clampPageLimit(request.limit);
      const query = checkQuery(request.query ?? "");
      if (request.folderId === GMAIL_ARCHIVE_ID) {
        return threadPage({ query: query ? `${GMAIL_ARCHIVE_QUERY} ${query}` : GMAIL_ARCHIVE_QUERY }, request.cursor, limit);
      }
      return threadPage({ labelIds: [gmailId(request.folderId)], ...(query ? { query } : {}) }, request.cursor, limit);
    },

    async getThread(id: string): Promise<MailThread> {
      const threadId = gmailId(id);
      const { raw, list } = await loadThread(threadId);
      threadMessageIds.set(threadId, gmailThreadMessageIds(raw));
      const labels = gmailThreadLabels(raw);
      const drafts = [...labels.values()].some((ids) => ids.includes("DRAFT")) ? await draftIdsByMessage() : new Map<string, string>();
      // Copies, so the cached messages are never changed in place.
      const ordered = list.map((message) => {
        const draftId = drafts.get(message.id);
        return draftId ? { ...message, draftId } : { ...message };
      }).sort((a, b) => compareInstants(a.sentAt, b.sentAt));
      const folderIds = new Set<string>();
      for (const ids of labels.values()) for (const folderId of gmailFolderIds(ids)) folderIds.add(folderId);
      return { id: threadId, accountId: account.id, subject: ordered[0]?.subject ?? "", folderIds: [...folderIds], messages: ordered };
    },

    async search(query: string, cursor?: string): Promise<Page<ThreadSummary>> {
      const text = checkQuery(query);
      if (!text) return { items: [], nextCursor: null };
      return threadPage({ query: text }, cursor, MAIL_PAGE_DEFAULT);
    },

    async modifyThreads(ids: string[], change: ThreadChange): Promise<void> {
      if (ids.length > MAX_MODIFY_THREADS) throw new ProviderError("not_supported", "Select fewer conversations.");
      const threadIds = ids.map(gmailId);
      if (threadIds.length === 0 || isEmptyThreadChange(change)) return;
      const { add, remove } = labelChanges(change);
      const perThread = await mapLimit(threadIds, MESSAGE_PARALLEL, async (threadId) => {
        const known = threadMessageIds.get(threadId);
        if (known) return known;
        const fresh = gmailThreadMessageIds(await caller.read("get_thread", { threadId, format: "summary" }));
        threadMessageIds.set(threadId, fresh);
        return fresh;
      });
      const messageIds = [...new Set(perThread.flat())];
      for (let start = 0; start < messageIds.length; start += BATCH_MODIFY_MAX) {
        await caller.write("batch_modify", {
          messageIds: messageIds.slice(start, start + BATCH_MODIFY_MAX),
          ...(add.length ? { addLabelIds: add } : {}),
          ...(remove.length ? { removeLabelIds: remove } : {}),
        });
      }
      if (change.read !== undefined) {
        for (const messageId of messageIds) {
          const cached = messages.get(messageId);
          if (cached) messages.set(messageId, { ...cached, unread: !change.read });
        }
      }
    },

    async saveDraft(draft: Draft): Promise<Draft> {
      assertDraftSavable(draft);
      const existingId = draft.id === undefined ? undefined : gmailId(draft.id);
      const reply = await replyContext(draft);
      const attachments = draft.attachments.map((attachment) => ({
        attachment,
        id: attachment.id ?? newAttachmentId(),
        contentBase64: attachmentContent.contentOf(existingId, attachment),
      }));
      const fields: Record<string, unknown> = {
        ...(draft.to.length ? { to: wireRecipients(draft.to) } : {}),
        ...(draft.cc.length ? { cc: wireRecipients(draft.cc) } : {}),
        ...(draft.bcc.length ? { bcc: wireRecipients(draft.bcc) } : {}),
        subject: wireSubject(draft.subject),
        bodyHtml: draftHtml(draft),
        bodyText: draftText(draft),
        ...(attachments.length ? {
          attachments: attachments.map(({ attachment, contentBase64 }) => ({
            filename: wireFilename(attachment.name), mimeType: wireMimeType(attachment.mimeType), contentBase64,
          })),
        } : {}),
        ...(reply ? { threadId: reply.threadId, inReplyTo: reply.inReplyTo, ...(reply.references.length ? { references: reply.references } : {}) } : {}),
      };
      const data = asRecord(existingId !== undefined
        ? await caller.write("update_draft", { draftId: existingId, ...fields })
        : await caller.write(reply ? "create_reply_draft" : "create_html_draft", fields));
      const draftId = asString(data.id);
      if (!GMAIL_ID.test(draftId)) throw new ProviderError("failed");
      const threadId = asString(asRecord(data.message).threadId) || reply?.threadId || draft.threadId;
      for (const { id, contentBase64 } of attachments) attachmentContent.remember(draftId, id, contentBase64);
      return {
        ...draft,
        id: draftId,
        ...(threadId ? { threadId } : {}),
        attachments: attachments.map(({ attachment, id, contentBase64 }) => ({ ...attachment, id, contentBase64 })),
      };
    },

    async deleteDraft(draftId: string): Promise<void> {
      await caller.write("delete_draft", { draftId: gmailId(draftId) });
    },

    async sendDraft(draftId: string): Promise<void> {
      await caller.write("send_draft", { draftId: gmailId(draftId) });
    },

    async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent> {
      const id = gmailId(messageId);
      const attachment = requireId(attachmentId, GMAIL_ID, GMAIL_ATTACHMENT_ID_MAX);
      // Gmail attachment ids change between fetches, so prefer the message the owner is looking at.
      const meta = (messages.get(id) ?? await fetchMessage(id)).attachments.find((item) => item.id === attachment);
      if (meta && meta.size > MAX_ATTACHMENT_READ_BYTES) throw new ProviderError("not_supported", "This attachment is too large to open here.");
      const data = asRecord(await caller.read("get_attachment", { messageId: id, attachmentId: attachment }));
      const raw = asString(data.data);
      if (!raw) throw new ProviderError("failed");
      let contentBase64: string;
      try {
        contentBase64 = base64UrlToBase64(raw);
      } catch (error: unknown) {
        if (error instanceof RangeError) throw new ProviderError("failed");
        throw error;
      }
      const size = asNumber(data.size) ?? base64DecodedBytes(contentBase64);
      if (size > MAX_ATTACHMENT_READ_BYTES) throw new ProviderError("not_supported", "This attachment is too large to open here.");
      return { name: meta?.name ?? "attachment", mimeType: meta?.mimeType ?? "application/octet-stream", size, contentBase64 };
    },

    async listSentTo(address: string, limit: number): Promise<MailMessage[]> {
      if (!isValidMailAddress(address.trim())) throw new ProviderError("not_supported", "Enter a valid address.");
      const count = Math.min(MAX_SENT_SAMPLES, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : MAX_SENT_SAMPLES)));
      const data = asRecord(await caller.read("search", { query: `in:sent to:${normalizeMailAddress(address)}`, maxResults: count }));
      const ids = asArray(data.messages).map((message) => asString(asRecord(message).id))
        .filter((id) => GMAIL_ID.test(id) && id.length <= GMAIL_ID_MAX).slice(0, count);
      const list = await mapLimit(ids, MESSAGE_PARALLEL, fetchMessage);
      return list.sort((a, b) => compareInstants(b.sentAt, a.sentAt));
    },
  };
}
