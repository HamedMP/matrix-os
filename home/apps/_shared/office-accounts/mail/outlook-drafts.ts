/**
 * Saving Outlook drafts: create, reply, update, attachments.
 *
 * Outlook stores each attachment with its own call and cannot remove one in
 * place through the actions available, so a draft that drops a stored
 * attachment is created again without it and the old one is moved to Deleted
 * Items (recoverable). The new copy is created first, so a failure never loses
 * the owner's text.
 */
import { ProviderError, type Draft, type DraftAttachment } from "../types/mail.js";
import { asArray, asRecord, asString, type ServiceCaller } from "./bridge.js";
import {
  AttachmentContentStore, assertDraftSavable, draftHtml, wireFilename, wireMimeType, wireRecipients, wireSubject,
} from "./drafts.js";
import { GRAPH_ID, GRAPH_ID_MAX, LruCache, requireId } from "./support.js";

const graphId = (value: unknown) => requireId(value, GRAPH_ID, GRAPH_ID_MAX);

interface PreparedAttachment {
  attachment: DraftAttachment;
  /** Set when the provider already stores it on the draft being updated. */
  storedId?: string;
  contentBase64: string | undefined;
}

export interface OutlookDraftWriter {
  save(draft: Draft): Promise<Draft>;
}

export function createOutlookDraftWriter(caller: ServiceCaller): OutlookDraftWriter {
  const content = new AttachmentContentStore();
  /** Attachment ids the provider stores per draft, as far as this adapter knows. */
  const storedIds = new LruCache<string, string[]>(100);

  function recipients(draft: Draft): Record<string, unknown> {
    return { toRecipients: wireRecipients(draft.to), ccRecipients: wireRecipients(draft.cc), bccRecipients: wireRecipients(draft.bcc) };
  }

  async function storedAttachmentIds(draftId: string): Promise<string[]> {
    const known = storedIds.get(draftId);
    if (known) return known;
    const data = await caller.read("list_attachments", { messageId: draftId });
    const ids = asArray(asRecord(data).value).map((item) => asString(asRecord(item).id)).filter(Boolean);
    storedIds.set(draftId, ids);
    return ids;
  }

  async function addAttachments(draftId: string, list: readonly PreparedAttachment[]): Promise<DraftAttachment[]> {
    const out: DraftAttachment[] = [];
    const ids = [...(storedIds.get(draftId) ?? [])];
    for (const item of list) {
      if (item.storedId) {
        out.push({ ...item.attachment, id: item.storedId });
        continue;
      }
      const base64 = item.contentBase64 as string;
      const data = asRecord(await caller.write("add_attachment", {
        messageId: draftId,
        name: wireFilename(item.attachment.name),
        contentType: wireMimeType(item.attachment.mimeType),
        contentBase64: base64,
      }));
      const id = asString(data.id);
      if (!id) throw new ProviderError("failed");
      content.remember(draftId, id, base64);
      ids.push(id);
      storedIds.set(draftId, ids);
      out.push({ ...item.attachment, id, contentBase64: base64 });
    }
    return out;
  }

  async function createFresh(draft: Draft, attachments: PreparedAttachment[]): Promise<Draft> {
    const subject = wireSubject(draft.subject);
    let data: Record<string, unknown>;
    if (draft.inReplyToMessageId) {
      data = asRecord(await caller.write("create_reply_draft", {
        messageId: graphId(draft.inReplyToMessageId), replyAll: false, bodyHtml: draftHtml(draft),
      }));
      const id = asString(data.id);
      if (!GRAPH_ID.test(id)) throw new ProviderError("failed");
      const hasRecipients = draft.to.length + draft.cc.length + draft.bcc.length > 0;
      // The provider filled in the sender and a `Re:` subject; apply what the owner chose instead.
      if (hasRecipients || subject) {
        await caller.write("update_draft", { messageId: id, ...(subject ? { subject } : {}), ...(hasRecipients ? recipients(draft) : {}) });
      }
    } else {
      data = asRecord(await caller.write("create_html_draft", { ...recipients(draft), subject, bodyHtml: draftHtml(draft) }));
    }
    const id = asString(data.id);
    if (!GRAPH_ID.test(id)) throw new ProviderError("failed");
    storedIds.set(id, []);
    const saved = await addAttachments(id, attachments.map((item) => ({ ...item, storedId: undefined })));
    const threadId = asString(data.conversationId) || draft.threadId;
    return { ...draft, id, ...(threadId ? { threadId } : {}), attachments: saved };
  }

  return {
    async save(draft: Draft): Promise<Draft> {
      assertDraftSavable(draft);
      const existingId = draft.id === undefined ? undefined : graphId(draft.id);
      const stored = existingId ? await storedAttachmentIds(existingId) : [];
      const prepared: PreparedAttachment[] = draft.attachments.map((attachment) => ({
        attachment,
        storedId: attachment.id && stored.includes(attachment.id) ? attachment.id : undefined,
        contentBase64: undefined,
      }));
      const removed = stored.filter((id) => !prepared.some((item) => item.storedId === id));
      const recreate = existingId !== undefined && removed.length > 0;
      // Read every file's content before the first write, so a missing file never leaves a half-made draft.
      for (const item of prepared) {
        if (!item.storedId || recreate) item.contentBase64 = content.contentOf(existingId, item.attachment);
      }

      if (existingId === undefined) return createFresh(draft, prepared);
      if (recreate) {
        const fresh = await createFresh({ ...draft, id: undefined }, prepared);
        await caller.write("delete_draft", { messageId: existingId });
        storedIds.delete(existingId);
        return fresh;
      }
      const data = asRecord(await caller.write("update_draft", {
        messageId: existingId, subject: wireSubject(draft.subject), bodyHtml: draftHtml(draft), ...recipients(draft),
      }));
      const saved = await addAttachments(existingId, prepared);
      const threadId = asString(data.conversationId) || draft.threadId;
      return { ...draft, id: existingId, ...(threadId ? { threadId } : {}), attachments: saved };
    },
  };
}
