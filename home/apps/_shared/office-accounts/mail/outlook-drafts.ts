/**
 * Saving Outlook drafts: create, reply, update, attachments.
 *
 * Outlook stores each attachment with its own call and cannot remove one in
 * place through the actions available, so a draft that drops a stored
 * attachment is created again without it and the old one is moved to Deleted
 * Items (recoverable). The new copy is created first, so a failure never loses
 * the owner's text.
 *
 * A save can take several calls. Once the provider has created a draft, a
 * later failure rejects with `DraftPartiallySavedError` carrying the new id
 * and the attachments stored so far, so the caller keeps that id and the next
 * save updates the same draft instead of creating another copy. An old draft
 * that a recreate could not delete is queued and deleted on a later save.
 */
import { DraftPartiallySavedError, ProviderError, type Draft, type DraftAttachment } from "../types/mail.js";
import { asArray, asRecord, asString, type ServiceCaller } from "./bridge.js";
import {
  AttachmentContentStore, assertDraftSavable, draftHtml, wireFilename, wireMimeType, wireRecipients, wireSubject,
} from "./drafts.js";
import { GRAPH_ID, GRAPH_ID_MAX, LruCache, requireId } from "./support.js";

const graphId = (value: unknown) => requireId(value, GRAPH_ID, GRAPH_ID_MAX);

/** Old drafts waiting to be moved to Deleted Items; the oldest are forgotten beyond this. */
const MAX_PENDING_DELETES = 20;
/** Attempts per queued delete before it is given up (the draft stays in Drafts). */
const MAX_DELETE_ATTEMPTS = 3;

interface PreparedAttachment {
  attachment: DraftAttachment;
  /** Set when the provider already stores it on the draft being updated. */
  storedId?: string;
  contentBase64: string | undefined;
}

type StoredDraft = Draft & { id: string };

export interface OutlookDraftWriter {
  save(draft: Draft): Promise<Draft>;
}

/** An attachment as the provider holds it after a failure: stored with its id, or still only local content. */
function leftover(item: PreparedAttachment): DraftAttachment {
  if (item.storedId) return { ...item.attachment, id: item.storedId };
  const rest: DraftAttachment = { ...item.attachment };
  delete rest.id;
  return item.contentBase64 ? { ...rest, contentBase64: item.contentBase64 } : rest;
}

/** Wraps a failure that happened after `draft` was stored; anything that is not a provider failure passes unchanged. */
function partialFailure(error: unknown, draft: StoredDraft, attachments: DraftAttachment[]): unknown {
  if (!(error instanceof ProviderError)) return error;
  return new DraftPartiallySavedError(error.code, { ...draft, attachments });
}

export function createOutlookDraftWriter(caller: ServiceCaller): OutlookDraftWriter {
  const content = new AttachmentContentStore();
  /** Attachment ids the provider stores per draft, as far as this adapter knows. */
  const storedIds = new LruCache<string, string[]>(100);
  /** Old draft id to failed delete attempts so far; insertion-ordered and capped. */
  const pendingDeletes = new Map<string, number>();

  function recipients(draft: Draft): Record<string, unknown> {
    return { toRecipients: wireRecipients(draft.to), ccRecipients: wireRecipients(draft.cc), bccRecipients: wireRecipients(draft.bcc) };
  }

  function queueDelete(draftId: string, attempts = 0): void {
    pendingDeletes.delete(draftId);
    if (attempts >= MAX_DELETE_ATTEMPTS) {
      console.warn("[office-accounts] microsoft_outlook gave up moving a replaced draft to Deleted Items");
      return;
    }
    pendingDeletes.set(draftId, attempts);
    while (pendingDeletes.size > MAX_PENDING_DELETES) {
      const oldest = pendingDeletes.keys().next();
      if (oldest.done) break;
      pendingDeletes.delete(oldest.value);
    }
  }

  /** Best effort: a failed delete is queued again and never fails the save it runs before. */
  async function flushDeletes(keepId: string | undefined): Promise<void> {
    for (const [draftId, attempts] of [...pendingDeletes]) {
      pendingDeletes.delete(draftId);
      // The owner's draft still points at it, so it is not an orphan.
      if (draftId === keepId) continue;
      try {
        await caller.write("delete_draft", { messageId: draftId });
        storedIds.delete(draftId);
      } catch (error: unknown) {
        if (!(error instanceof ProviderError)) throw error;
        queueDelete(draftId, attempts + 1);
      }
    }
  }

  async function storedAttachmentIds(draftId: string): Promise<string[]> {
    const known = storedIds.get(draftId);
    if (known) return known;
    const data = await caller.read("list_attachments", { messageId: draftId });
    const ids = asArray(asRecord(data).value).map((item) => asString(asRecord(item).id)).filter(Boolean);
    storedIds.set(draftId, ids);
    return ids;
  }

  async function addAttachments(draft: StoredDraft, list: readonly PreparedAttachment[]): Promise<DraftAttachment[]> {
    const out: DraftAttachment[] = [];
    const ids = [...(storedIds.get(draft.id) ?? [])];
    for (const [index, item] of list.entries()) {
      if (item.storedId) {
        out.push({ ...item.attachment, id: item.storedId });
        continue;
      }
      const base64 = item.contentBase64 as string;
      try {
        const data = asRecord(await caller.write("add_attachment", {
          messageId: draft.id,
          name: wireFilename(item.attachment.name),
          contentType: wireMimeType(item.attachment.mimeType),
          contentBase64: base64,
        }));
        const id = asString(data.id);
        if (!id) throw new ProviderError("failed");
        content.remember(draft.id, id, base64);
        ids.push(id);
        storedIds.set(draft.id, ids);
        out.push({ ...item.attachment, id, contentBase64: base64 });
      } catch (error: unknown) {
        throw partialFailure(error, draft, [...out, ...list.slice(index).map(leftover)]);
      }
    }
    return out;
  }

  async function createFresh(draft: Draft, attachments: PreparedAttachment[]): Promise<Draft> {
    const subject = wireSubject(draft.subject);
    const data = asRecord(draft.inReplyToMessageId
      ? await caller.write("create_reply_draft", { messageId: graphId(draft.inReplyToMessageId), replyAll: false, bodyHtml: draftHtml(draft) })
      : await caller.write("create_html_draft", { ...recipients(draft), subject, bodyHtml: draftHtml(draft) }));
    const id = asString(data.id);
    if (!GRAPH_ID.test(id)) throw new ProviderError("failed");
    storedIds.set(id, []);
    const threadId = asString(data.conversationId) || draft.threadId;
    const stored: StoredDraft = { ...draft, id, ...(threadId ? { threadId } : {}) };
    const fresh = attachments.map((item) => ({ ...item, storedId: undefined }));
    const hasRecipients = draft.to.length + draft.cc.length + draft.bcc.length > 0;
    // The provider filled in the sender and a `Re:` subject; apply what the owner chose instead.
    if (draft.inReplyToMessageId && (hasRecipients || subject)) {
      try {
        await caller.write("update_draft", { messageId: id, ...(subject ? { subject } : {}), ...(hasRecipients ? recipients(draft) : {}) });
      } catch (error: unknown) {
        throw partialFailure(error, stored, fresh.map(leftover));
      }
    }
    return { ...stored, attachments: await addAttachments(stored, fresh) };
  }

  async function recreate(draft: Draft, existingId: string, prepared: PreparedAttachment[]): Promise<Draft> {
    let fresh: Draft;
    try {
      fresh = await createFresh({ ...draft, id: undefined }, prepared);
    } catch (error: unknown) {
      // The owner now keeps the new copy, so the old one would be left behind.
      if (error instanceof DraftPartiallySavedError) queueDelete(existingId);
      throw error;
    }
    try {
      await caller.write("delete_draft", { messageId: existingId });
      storedIds.delete(existingId);
    } catch (error: unknown) {
      if (!(error instanceof ProviderError)) throw error;
      queueDelete(existingId);
    }
    return fresh;
  }

  return {
    async save(draft: Draft): Promise<Draft> {
      assertDraftSavable(draft);
      const existingId = draft.id === undefined ? undefined : graphId(draft.id);
      await flushDeletes(existingId);
      const stored = existingId ? await storedAttachmentIds(existingId) : [];
      const prepared: PreparedAttachment[] = draft.attachments.map((attachment) => ({
        attachment,
        storedId: attachment.id && stored.includes(attachment.id) ? attachment.id : undefined,
        contentBase64: undefined,
      }));
      const removed = stored.filter((id) => !prepared.some((item) => item.storedId === id));
      const mustRecreate = existingId !== undefined && removed.length > 0;
      // Read every file's content before the first write, so a missing file never leaves a half-made draft.
      for (const item of prepared) {
        if (!item.storedId || mustRecreate) item.contentBase64 = content.contentOf(existingId, item.attachment);
      }

      if (existingId === undefined) return createFresh(draft, prepared);
      if (mustRecreate) return recreate(draft, existingId, prepared);
      const data = asRecord(await caller.write("update_draft", {
        messageId: existingId, subject: wireSubject(draft.subject), bodyHtml: draftHtml(draft), ...recipients(draft),
      }));
      const threadId = asString(data.conversationId) || draft.threadId;
      const current: StoredDraft = { ...draft, id: existingId, ...(threadId ? { threadId } : {}) };
      return { ...current, attachments: await addAttachments(current, prepared) };
    },
  };
}
