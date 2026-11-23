/**
 * `MailProvider` for Outlook, over the `microsoft_outlook` integration actions
 * listed in specs/2710-office-mail-suite/integration-actions.md (sections 6 and 9).
 *
 * Message ids are immutable (the actions ask for them), so a message keeps its
 * id when it moves. Thread ids are conversation ids.
 */
import {
  MAIL_PAGE_DEFAULT, MAX_ATTACHMENT_READ_BYTES, MAX_MODIFY_THREADS, MAX_SENT_SAMPLES,
  ProviderError, base64DecodedBytes, clampPageLimit, compareInstants, isEmptyThreadChange, isValidMailAddress,
  normalizeMailAddress, sameMailAddress, toProviderError,
  type AttachmentContent, type Draft, type ListThreadsRequest, type MailFolder, type MailFolderRole, type MailMessage,
  type MailProvider, type MailThread, type Page, type ThreadChange, type ThreadSummary,
} from "../types/mail.js";
import { asArray, asNumber, asRecord, asString, createServiceCaller } from "./bridge.js";
import { wireBase64 } from "./drafts.js";
import { createOutlookDraftWriter } from "./outlook-drafts.js";
import {
  OUTLOOK_STARRED_ID, OUTLOOK_WELL_KNOWN, graphSkipToken, normalizeGraphMessage, outlookFolders, readGraphAttachments,
  readGraphFolder, readGraphMessageRef, summarizeGraphMessages, type GraphFolder, type GraphMessageRef,
} from "./outlook-normalize.js";
import { createMessageCache, type MailAdapterOptions } from "./provider-options.js";
import { GRAPH_ID, GRAPH_ID_MAX, LruCache, decodeCursor, encodeCursor, mapLimit, requireId } from "./support.js";
import { stripControl } from "./text.js";

const PARALLEL = 4;
const FOLDER_PAGE = 100;
const MAX_FOLDER_PAGES = 5;
const CONVERSATION_PAGE = 50;
const MAX_CONVERSATION_SKIP = 500;
const MAX_FOLDER_SKIP = 5000;
const MAX_QUERY_CHARS = 512;
/** Upper bound on per-message writes one `modifyThreads` call may make. */
const MAX_MESSAGE_WRITES = 500;
const LIST_CURSOR = "o";
const SEARCH_CURSOR = "s";

const graphId = (value: unknown) => requireId(value, GRAPH_ID, GRAPH_ID_MAX);

function checkQuery(query: string): string {
  const trimmed = stripControl(query.replace(/\s+/g, " ")).trim();
  if (trimmed.length > MAX_QUERY_CHARS) throw new ProviderError("not_supported", "The search is too long.");
  return trimmed;
}

/** Rethrows anything but `failed`, which the caller treats as "absent" after logging. */
function onlyFailed(error: unknown, what: string): void {
  const failure = toProviderError(error);
  if (failure.code !== "failed") throw failure;
  console.warn(`[office-accounts] outlook ${what} unavailable`, failure.code);
}

export function createOutlookProvider(options: MailAdapterOptions): MailProvider {
  const { account } = options;
  const caller = createServiceCaller(options.bridge, "microsoft_outlook", options.label);
  const messages = createMessageCache();
  const refs = new LruCache<string, GraphMessageRef>(2000);
  /** Complete message id lists of conversations, from `list_conversation`. */
  const conversations = new LruCache<string, string[]>(300);
  /** Conversation ids already returned on earlier pages of a listing, keyed by the page that follows. */
  const seenByPage = new LruCache<string, string[]>(50);
  const drafts = createOutlookDraftWriter(caller);

  function remember(rawMessages: readonly unknown[]): GraphMessageRef[] {
    const out: GraphMessageRef[] = [];
    for (const raw of rawMessages) {
      const ref = readGraphMessageRef(raw);
      if (!ref) continue;
      refs.set(ref.id, ref);
      out.push(ref);
    }
    return out;
  }

  async function listConversation(conversationId: string, includeBody: boolean): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let skip = 0; skip <= MAX_CONVERSATION_SKIP; skip += CONVERSATION_PAGE) {
      const data = asRecord(await caller.read("list_conversation", {
        conversationId, top: CONVERSATION_PAGE, ...(skip ? { skip } : {}), ...(includeBody ? {} : { includeBody: false }),
      }));
      const page = asArray(data.value);
      out.push(...page);
      if (page.length < CONVERSATION_PAGE) break;
    }
    conversations.set(conversationId, remember(out).map((ref) => ref.id));
    return out;
  }

  async function conversationRefs(conversationId: string): Promise<GraphMessageRef[]> {
    const ids = conversations.get(conversationId);
    const known = ids?.map((id) => refs.get(id));
    if (known && known.every((ref): ref is GraphMessageRef => ref !== undefined)) return known;
    return remember(await listConversation(conversationId, false));
  }

  async function attachmentsOf(messageId: string) {
    try {
      return readGraphAttachments(await caller.read("list_attachments", { messageId }));
    } catch (error: unknown) {
      onlyFailed(error, "attachment list");
      return [];
    }
  }

  async function fetchMessage(messageId: string): Promise<MailMessage> {
    const cached = messages.get(messageId);
    if (cached) return cached;
    const raw = asRecord(await caller.read("get_message", { messageId }));
    remember([raw]);
    const message = normalizeGraphMessage(raw, raw.hasAttachments === true ? await attachmentsOf(messageId) : []);
    messages.set(messageId, message);
    return message;
  }

  /** One page of summaries, with conversations seen on earlier pages of the same listing left out. */
  function pageOf(rawMessages: unknown[], listingKey: string, cursor: string | undefined, nextCursor: string | null): Page<ThreadSummary> {
    remember(rawMessages);
    const prior = cursor ? seenByPage.get(`${listingKey}\u0000${cursor}`) ?? [] : [];
    const items = summarizeGraphMessages(rawMessages, account.id).filter((item) => !prior.includes(item.id));
    if (nextCursor) seenByPage.set(`${listingKey}\u0000${nextCursor}`, [...prior, ...items.map((item) => item.id)].slice(-1000));
    return { items, nextCursor };
  }

  async function folderPage(folderId: string, filter: string | undefined, cursor: string | undefined, limit: number): Promise<Page<ThreadSummary>> {
    const token = decodeCursor(cursor, [LIST_CURSOR]);
    const skip = token ? Number(token.value) : 0;
    if (!Number.isInteger(skip) || skip < 0 || skip > MAX_FOLDER_SKIP) throw new ProviderError("not_supported", "This page is no longer available. Reload the list.");
    const data = asRecord(await caller.read("list_folder_messages", {
      folderId, top: limit, ...(skip ? { skip } : {}), ...(filter ? { filter } : {}),
    }));
    const page = asArray(data.value);
    const more = (page.length >= limit || asString(data["@odata.nextLink"]) !== "") && skip + limit <= MAX_FOLDER_SKIP;
    return pageOf(page, `list\u0000${folderId}\u0000${filter ?? ""}`, cursor, more ? encodeCursor(LIST_CURSOR, skip + limit) : null);
  }

  async function searchPage(query: string, folderId: string | undefined, cursor: string | undefined, limit: number,
    keep: (raw: unknown) => boolean = () => true): Promise<Page<ThreadSummary>> {
    const token = decodeCursor(cursor, [SEARCH_CURSOR]);
    const data = asRecord(await caller.read("search_messages", {
      query, ...(folderId ? { folderId } : {}), top: limit, ...(token ? { skipToken: token.value } : {}),
    }));
    const next = graphSkipToken(data);
    return pageOf(asArray(data.value).filter(keep), `search\u0000${folderId ?? ""}\u0000${query}`, cursor,
      next ? encodeCursor(SEARCH_CURSOR, next) : null);
  }

  async function listAllFolders(): Promise<GraphFolder[]> {
    const out: GraphFolder[] = [];
    for (let page = 0; page < MAX_FOLDER_PAGES; page++) {
      const data = asRecord(await caller.read("list_folders", { limit: FOLDER_PAGE, ...(page ? { skip: String(page * FOLDER_PAGE) } : {}) }));
      const value = asArray(data.value);
      out.push(...value.map(readGraphFolder).filter((folder): folder is GraphFolder => folder !== null));
      if (value.length < FOLDER_PAGE) break;
    }
    return out;
  }

  return {
    async listFolders(): Promise<MailFolder[]> {
      const [listed, resolved] = await Promise.all([
        listAllFolders(),
        mapLimit(OUTLOOK_WELL_KNOWN, 3, async ([name, role]): Promise<[MailFolderRole, GraphFolder | null]> => {
          try {
            return [role, readGraphFolder(await caller.read("get_folder", { folderId: name }))];
          } catch (error: unknown) {
            // A mailbox without an archive folder answers with an error; the role is then absent.
            onlyFailed(error, `${name} folder`);
            return [role, null];
          }
        }),
      ]);
      const wellKnown = new Map<MailFolderRole, GraphFolder>();
      for (const [role, folder] of resolved) if (folder) wellKnown.set(role, folder);
      return outlookFolders(listed, wellKnown);
    },

    async listThreads(request: ListThreadsRequest): Promise<Page<ThreadSummary>> {
      const limit = clampPageLimit(request.limit);
      const query = checkQuery(request.query ?? "");
      const starred = request.folderId === OUTLOOK_STARRED_ID;
      const folderId = starred ? "inbox" : graphId(request.folderId);
      if (query) {
        // Search cannot be combined with a filter, so the starred view keeps flagged results itself.
        const keep = starred ? (raw: unknown) => asString(asRecord(asRecord(raw).flag).flagStatus) === "flagged" : undefined;
        return searchPage(query, folderId, request.cursor, limit, keep);
      }
      return folderPage(folderId, starred ? "flagged" : undefined, request.cursor, limit);
    },

    async getThread(id: string): Promise<MailThread> {
      const conversationId = graphId(id);
      let raw: unknown[];
      try {
        raw = await listConversation(conversationId, true);
      } catch (error: unknown) {
        // A conversation over the reply cap fails as a whole; read it message by message.
        if (toProviderError(error).code !== "failed") throw toProviderError(error);
        const ids = (await conversationRefs(conversationId)).map((ref) => ref.id);
        raw = await mapLimit(ids, PARALLEL, (messageId) => caller.read("get_message", { messageId }));
      }
      if (raw.length === 0) throw new ProviderError("not_supported", "That conversation could not be found.");
      const list = await mapLimit(raw.map(asRecord), PARALLEL, async (message) => {
        const messageId = asString(message.id);
        const normalized = normalizeGraphMessage(message, message.hasAttachments === true && messageId ? await attachmentsOf(messageId) : []);
        if (messageId) messages.set(messageId, normalized);
        return { ...normalized };
      });
      list.sort((a, b) => compareInstants(a.sentAt, b.sentAt));
      const folderIds = [...new Set(raw.map((message) => asString(asRecord(message).parentFolderId)).filter(Boolean))];
      return { id: conversationId, accountId: account.id, subject: list[0]?.subject ?? "", folderIds, messages: list };
    },

    async search(query: string, cursor?: string): Promise<Page<ThreadSummary>> {
      const text = checkQuery(query);
      if (!text) return { items: [], nextCursor: null };
      return searchPage(text, undefined, cursor, MAIL_PAGE_DEFAULT);
    },

    async modifyThreads(ids: string[], change: ThreadChange): Promise<void> {
      if (ids.length > MAX_MODIFY_THREADS) throw new ProviderError("not_supported", "Select fewer conversations.");
      const threadIds = ids.map(graphId);
      if (threadIds.length === 0 || isEmptyThreadChange(change)) return;
      const add = change.addFolders ?? [];
      const remove = change.removeFolders ?? [];
      if ([...add, ...remove].includes(OUTLOOK_STARRED_ID)) throw new ProviderError("not_supported");
      if (add.length === 0 && remove.length > 0) throw new ProviderError("not_supported");
      const destination = add.length ? graphId(add[0]) : undefined;
      const from = new Set(remove.map(graphId));

      const all = (await mapLimit(threadIds, PARALLEL, conversationRefs)).flat();
      const updates = all.flatMap((ref) => {
        const patch: Record<string, unknown> = {};
        if (change.read !== undefined && ref.isRead !== change.read) patch.isRead = change.read;
        if (change.flagged !== undefined && ref.flagged !== change.flagged) patch.flagged = change.flagged;
        return Object.keys(patch).length ? [{ ref, patch }] : [];
      });
      // A move takes what is in the folder being left (all of the thread when none is named), so
      // archiving from the inbox never pulls the owner's sent replies out of Sent.
      const moves = destination === undefined ? [] : all.filter((ref) => ref.parentFolderId !== destination
        && (from.size === 0 || !ref.parentFolderId || from.has(ref.parentFolderId)));
      if (updates.length + moves.length > MAX_MESSAGE_WRITES) throw new ProviderError("not_supported", "Select fewer conversations.");

      await mapLimit(updates, PARALLEL, async ({ ref, patch }) => {
        await caller.write("update_message", { messageId: ref.id, ...patch });
        const next = { ...ref, isRead: (patch.isRead as boolean | undefined) ?? ref.isRead, flagged: (patch.flagged as boolean | undefined) ?? ref.flagged };
        refs.set(ref.id, next);
        const cached = messages.get(ref.id);
        if (cached && patch.isRead !== undefined) messages.set(ref.id, { ...cached, unread: !patch.isRead });
      });
      await mapLimit(moves, PARALLEL, async (ref) => {
        await caller.write("move_message", { messageId: ref.id, destinationFolderId: destination });
        refs.set(ref.id, { ...(refs.get(ref.id) ?? ref), parentFolderId: destination as string });
      });
    },

    saveDraft(draft: Draft): Promise<Draft> {
      return drafts.save(draft);
    },

    async deleteDraft(draftId: string): Promise<void> {
      await caller.write("delete_draft", { messageId: graphId(draftId) });
    },

    async sendDraft(draftId: string): Promise<void> {
      await caller.write("send_draft", { messageId: graphId(draftId) });
    },

    async getAttachment(messageId: string, attachmentId: string): Promise<AttachmentContent> {
      const id = graphId(messageId);
      const attachment = graphId(attachmentId);
      const meta = readGraphAttachments(await caller.read("list_attachments", { messageId: id })).find((item) => item.id === attachment);
      if (!meta) throw new ProviderError("not_supported", "That attachment could not be found.");
      if (meta.size > MAX_ATTACHMENT_READ_BYTES) throw new ProviderError("not_supported", "This attachment is too large to open here.");
      const data = asRecord(await caller.read("get_attachment", { messageId: id, attachmentId: attachment }));
      const bytes = asString(data.contentBytes);
      // Linked items and messages carry no content bytes.
      if (!bytes) throw new ProviderError("not_supported", "This attachment cannot be opened here.");
      let contentBase64: string;
      try {
        contentBase64 = wireBase64(bytes);
      } catch (error: unknown) {
        if (error instanceof ProviderError) throw new ProviderError("failed");
        throw error;
      }
      const size = base64DecodedBytes(contentBase64);
      if (size > MAX_ATTACHMENT_READ_BYTES) throw new ProviderError("not_supported", "This attachment is too large to open here.");
      return {
        name: asString(data.name) || meta.name, mimeType: asString(data.contentType) || meta.mimeType,
        size: asNumber(data.size) ?? size, contentBase64,
      };
    },

    async listSentTo(address: string, limit: number): Promise<MailMessage[]> {
      if (!isValidMailAddress(address.trim())) throw new ProviderError("not_supported", "Enter a valid address.");
      const count = Math.min(MAX_SENT_SAMPLES, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : MAX_SENT_SAMPLES)));
      const data = asRecord(await caller.read("search_messages", { query: `to:${normalizeMailAddress(address)}`, folderId: "sentitems", top: count }));
      const ownerOnly = asArray(data.value).map(asRecord).filter((message) => {
        const from = asString(asRecord(asRecord(message.from).emailAddress).address);
        return !account.address || !from || sameMailAddress(from, account.address);
      });
      const ids = ownerOnly.map((message) => asString(message.id)).filter((id) => GRAPH_ID.test(id) && id.length <= GRAPH_ID_MAX).slice(0, count);
      const list = await mapLimit(ids, PARALLEL, fetchMessage);
      return list.sort((a, b) => compareInstants(b.sentAt, a.sentAt));
    },
  };
}
