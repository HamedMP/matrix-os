/**
 * Matrix chat source: committed messages of the chats the owner opted in (chatIds), read through the owner's
 * ChatRepository, never any other chat. One matrix_chat document per (chat, UTC day, part). Each run continues one
 * full pass (chats in id order, messages in seq order), then a sweep tombstones documents of chats that are no
 * longer opted in or no longer exist for the owner.
 */
import { z } from "zod/v4";
import {
  BRAIN_SOURCE_OPTIONS_MAX, BrainFeatureError, type BrainMatrixChatSourceConfig, type BrainSourceAdapter,
  type BrainSourceKindHandler, type BrainSourceReadContext, type BrainSourceReadResult,
} from "../../contracts.js";
import { CHAT_GROUP_FETCH_MAX, ChatMessageQueue, readChatGroup, skipChatDay, type ChatGroup } from "./chat-render.js";
import { identifyChats, parseChatConfig } from "./config.js";
import { loadMatrixConfig, saveMatrixConfig } from "./database.js";
import {
  MatrixPageDraft, cleanText, decodeMatrixCursor, documentTitle, encodeMatrixCursor, firstRef, fitBody, guardRead,
  matrixDocumentId, resumeIndex, sweepStep, readThrough,
} from "./shared.js";
import {
  BRAIN_MATRIX_LIMITS, type BrainMatrixChatHandlerDeps, type BrainMatrixChatOwner, type BrainMatrixChatReader,
} from "./types.js";

const KIND = "matrix_chat" as const;
const CURSOR_PREFIX = "mc1:";
const OPTIONS_PREFIX = "mco1:";
const L = BRAIN_MATRIX_LIMITS;
/** Refs one day may carry: per part the chat ref and at most 50 participants. */
const DAY_REFS_MAX = L.chatPartsPerDay * 51;
const CHAT_OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const chatIdText = z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/);
const CursorSchema = z.discriminatedUnion("phase", [
  z.object({
    v: z.literal(1), phase: z.literal("scan"), chat: z.union([z.literal(""), chatIdText]),
    afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), skipDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }).strict(),
  z.object({ v: z.literal(1), phase: z.literal("sweep"), after: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
]);
type ChatCursor = z.infer<typeof CursorSchema>;
const START: ChatCursor = { v: 1, phase: "scan", chat: "", afterSeq: 0, skipDay: null };
const OptionsCursorSchema = z.object({
  v: z.literal(1), activityAt: z.iso.datetime({ offset: true }), chatId: chatIdText,
}).strict();

type Context = BrainSourceReadContext<BrainMatrixChatSourceConfig>;

/** The chat owner of a brain owner id, or null when the id cannot own chats. */
export function chatOwner(ownerId: string): BrainMatrixChatOwner | null {
  return CHAT_OWNER_ID.test(ownerId) && !ownerId.includes("..") ? { type: "personal", ownerId } : null;
}

function emitGroup(context: Context, draft: MatrixPageDraft, chatId: string, chatTitle: string, group: ChatGroup) {
  if (group.truncated) draft.notices.add("items_truncated");
  group.parts.forEach((part, index) => {
    const suffix = ` - ${group.day}${index === 0 ? "" : ` (part ${index + 1})`}`;
    const title = documentTitle(chatTitle, "Chat", suffix);
    draft.upsert({
      documentId: matrixDocumentId(KIND, context.externalRef, [chatId, group.day, index]), title,
      body: fitBody(title, part.lines.join("\n")).body, permalink: "", sourceUpdatedAt: part.lastAt,
      provenance: "matrix_chat",
      refs: [{ kind: "chat", value: chatId }, ...part.participants.map((value) => ({ kind: "participant", value }))],
    });
  });
}

async function scan(
  context: Context, reader: BrainMatrixChatReader, owner: BrainMatrixChatOwner, cursor: Extract<ChatCursor, { phase: "scan" }>,
): Promise<BrainSourceReadResult> {
  const draft = new MatrixPageDraft(context);
  const { chatIds } = context.config;
  const reads = { fetched: 0 };
  let index = resumeIndex(chatIds, cursor.chat);
  const resumed = chatIds[index] === cursor.chat;
  let afterSeq = resumed ? cursor.afterSeq : 0;
  let skipDay = resumed ? cursor.skipDay : null;
  const stopAt = (chat: string, seq: number, day: string | null) =>
    draft.page(encodeMatrixCursor(CURSOR_PREFIX, { v: 1, phase: "scan", chat, afterSeq: seq, skipDay: day }), false);
  for (; index < chatIds.length; index += 1) {
    const chatId = chatIds[index]!;
    const record = await readThrough("chat read", () => reader.get(owner, chatId));
    if (record !== null) {
      const queue = new ChatMessageQueue(reader, owner, chatId, afterSeq, reads);
      if (skipDay !== null && !(await skipChatDay(queue, skipDay))) return stopAt(chatId, queue.consumedSeq, skipDay);
      const title = cleanText(record.chat.title);
      for (;;) {
        // Peek first: a chat with nothing left moves on, so a cursor never points at a chat's end, where a message
        // added later to its last day would start that day again at part 0. After a group the peek reads nothing;
        // at a chat's start it reads one call, so a fresh page still has room for a whole group.
        const first = await queue.peek();
        if (first === null) break;
        const room = first !== "budget" && draft.fits(L.chatPartsPerDay, DAY_REFS_MAX)
          && reads.fetched + CHAT_GROUP_FETCH_MAX <= L.chatReadsPerPage;
        if (!room || context.signal.aborted) return stopAt(chatId, queue.consumedSeq, null);
        const group = await readChatGroup(queue, first, owner.ownerId);
        emitGroup(context, draft, chatId, title, group);
        if (!group.complete) return stopAt(chatId, queue.consumedSeq, group.day);
      }
    }
    afterSeq = 0;
    skipDay = null;
  }
  return draft.page(encodeMatrixCursor(CURSOR_PREFIX, { v: 1, phase: "sweep", after: null }), false);
}

export function createMatrixChatAdapter(
  reader: BrainMatrixChatReader, owner: BrainMatrixChatOwner,
): BrainSourceAdapter<BrainMatrixChatSourceConfig> {
  return {
    kind: KIND,
    readPage: (context) => guardRead(async () => {
      const { maxUpserts, maxRefs } = context.limits;
      if (maxUpserts < L.chatPartsPerDay || maxRefs < DAY_REFS_MAX) return { ok: false, code: "invalid_options" };
      const cursor = context.cursor === null ? START : decodeMatrixCursor(CURSOR_PREFIX, CursorSchema, context.cursor);
      if (cursor === null) return { ok: false, code: "cursor_invalid" };
      if (cursor.phase === "scan") return scan(context, reader, owner, cursor);
      const draft = new MatrixPageDraft(context);
      // At most one entry per configured chat (50), dropped with the page.
      const exists = new Map<string, boolean>();
      const after = await sweepStep(context, draft, cursor.after, async ({ refs }) => {
        const chatId = firstRef(refs, "chat");
        if (chatId === null || !context.config.chatIds.includes(chatId)) return false;
        if (!exists.has(chatId)) exists.set(chatId, (await readThrough("chat read", () => reader.get(owner, chatId))) !== null);
        return exists.get(chatId) === true;
      });
      const next: ChatCursor = after === null ? START : { v: 1, phase: "sweep", after };
      return draft.page(encodeMatrixCursor(CURSOR_PREFIX, next), after === null);
    }),
  };
}

/** The owner's active chats, newest activity first, for opting chats in; q filters titles within each page. */
async function chatOptions(reader: BrainMatrixChatReader, owner: BrainMatrixChatOwner, q: string | undefined, cursor: string | undefined) {
  const position = cursor === undefined ? undefined : decodeMatrixCursor(OPTIONS_PREFIX, OptionsCursorSchema, cursor);
  if (position === null || (q !== undefined && q.length > 200)) throw new BrainFeatureError("source_config_invalid");
  const page = await readThrough("chat list", () => reader.list(owner, {
    limit: BRAIN_SOURCE_OPTIONS_MAX, lifecycle: "active",
    ...(position === undefined ? {} : { cursor: { activityAt: position.activityAt, chatId: position.chatId } }),
  }));
  const needle = q?.trim().toLowerCase() ?? "";
  const items = page.items
    .filter(({ chat }) => needle === "" || chat.title.toLowerCase().includes(needle))
    .slice(0, BRAIN_SOURCE_OPTIONS_MAX)
    .map(({ chat }) => ({
      id: chat.id, label: documentTitle(chat.title, "Chat").slice(0, 120), detail: (chat.activityAt ?? chat.updatedAt).slice(0, 10),
    }));
  const next = page.nextCursor;
  return { items, nextCursor: next === undefined ? null : encodeMatrixCursor(OPTIONS_PREFIX, { v: 1, ...next }) };
}

export function createBrainMatrixChatHandler(
  deps: BrainMatrixChatHandlerDeps,
): BrainSourceKindHandler<BrainMatrixChatSourceConfig> {
  const now = deps.now ?? (() => new Date());
  return {
    kind: KIND,
    parseConfig: parseChatConfig,
    identify: (_project, config) => identifyChats(config),
    saveConfig: (scope, sourceId, config) => saveMatrixConfig(deps.kysely, KIND, scope, sourceId, config, now()),
    async loadConfig(scope, sourceId) {
      const raw = await loadMatrixConfig(deps.kysely, KIND, scope, sourceId);
      return raw === null ? null : parseChatConfig(raw);
    },
    async createAdapter(ownerId) {
      const owner = chatOwner(ownerId);
      if (deps.chats === null || owner === null) return { ok: false, code: "not_connected" };
      return { ok: true, adapter: createMatrixChatAdapter(deps.chats, owner) };
    },
    viewConfig: (config) => ({ chatIds: [...config.chatIds] }),
    async availability(ownerId) {
      if (deps.chats === null) return { available: false, reason: "not_configured" };
      return chatOwner(ownerId) === null ? { available: false, reason: "not_connected" } : { available: true };
    },
    async listOptions(ownerId, _project, query) {
      const owner = chatOwner(ownerId);
      if (deps.chats === null || owner === null) return { kind: KIND, items: [], nextCursor: null };
      return { kind: KIND, ...(await chatOptions(deps.chats, owner, query.q, query.cursor)) };
    },
  };
}
