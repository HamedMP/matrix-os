/**
 * Bot threads (spec 567): many Chats of one recipe Bot, each fixed to one project when it is created. A thread is
 * an ordinary canonical Chat; only its binding says which Bot runs it and which project that Bot reads.
 *
 * Create resolves the project owner-scoped first, then, under the owner lock, checks the Bot (the owner's, active,
 * and its recipe allows threads) and the cap, creates the Chat and binds it in one transaction. A replay with the
 * same request and project returns the same Chat; a Chat that already holds that request for anything else is a
 * conflict and is never adopted. The project is written once and no code path changes it.
 */
import { randomUUID } from "node:crypto";
import {
  CanonicalChatApiCursorSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  ChatAgentIdSchema,
  CreateBotThreadRequestSchema,
  type BotThreadListQuery,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { ChatRepository } from "../chat/repository.js";
import type { BotBrainProjects } from "./brain-projects.js";
import { ownerBotExecutor } from "./instantiation.js";
import { BotRecipeCatalogError, type BotRecipeCatalog } from "./recipe-catalog.js";
import { createBotBindingsRepository, type BotThreadCursor } from "./repositories/bindings.js";
import { BotStateError } from "./repositories/shared.js";

/** Live threads per Bot; deleting a thread Chat frees its place. */
export const MAX_BOT_THREADS = 1_000;
const DEFAULT_THREAD_TITLE = "New chat";

export type BotThreadErrorCode = "invalid_request" | "not_found" | "conflict" | "rate_limited" | "unavailable";

/** Allowlisted failures; the bots route maps each to one status and a generic message. */
export class BotThreadError extends Error {
  constructor(readonly code: BotThreadErrorCode) {
    super(`Bot thread request failed: ${code}`);
    this.name = "BotThreadError";
  }
}

const CursorSchema = z.object({
  version: z.literal(1),
  kind: z.literal("bot_threads"),
  activityAt: z.iso.datetime({ offset: true }),
  chatId: CanonicalChatIdSchema,
}).strict();

function encodeCursor(cursor: BotThreadCursor): string {
  return CanonicalChatApiCursorSchema.parse(`chatcur_${Buffer.from(JSON.stringify({ version: 1, kind: "bot_threads", ...cursor }), "utf8").toString("base64url")}`);
}

function decodeCursor(value: string): BotThreadCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice("chatcur_".length), "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BotThreadError("invalid_request");
  }
  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success) throw new BotThreadError("invalid_request");
  return { activityAt: parsed.data.activityAt, chatId: parsed.data.chatId };
}

export function createBotThreads(deps: {
  chats: Pick<ChatRepository, "kysely" | "withTransaction" | "get">;
  agents: Pick<ChatAgentStore, "get">;
  recipes: Pick<BotRecipeCatalog, "resolve">;
  /** Without it threads are unavailable: their project cannot be checked. */
  projects?: Pick<BotBrainProjects, "resolve">;
  now?: () => Date;
}) {
  const bindings = createBotBindingsRepository(ownerBotExecutor(deps.chats.kysely));
  const now = () => (deps.now?.() ?? new Date()).toISOString();

  /** The owner's active Bot whose recipe allows threads; anything else reads as not found. */
  async function threadBot(ownerId: string, agentIdInput: string) {
    const agentId = ChatAgentIdSchema.safeParse(agentIdInput);
    if (!agentId.success) throw new BotThreadError("invalid_request");
    const agent = await deps.agents.get({ type: "personal", ownerId }, agentId.data);
    if (!agent || agent.archived || !agent.recipeRef) throw new BotThreadError("not_found");
    try {
      if (!deps.recipes.resolve(agent.recipeRef).threads) throw new BotThreadError("not_found");
    } catch (error: unknown) {
      if (error instanceof BotRecipeCatalogError) throw new BotThreadError("not_found");
      throw error;
    }
    return agent;
  }

  return {
    async create(ownerId: string, agentId: string, body: unknown): Promise<{ record: CanonicalChatRecord; operation: "created" | "replayed" }> {
      const request = CreateBotThreadRequestSchema.safeParse(body);
      if (!request.success) throw new BotThreadError("invalid_request");
      if (!deps.projects) throw new BotThreadError("unavailable");
      const project = await deps.projects.resolve(ownerId, request.data.projectId);
      if (!project || project.projectId !== request.data.projectId) throw new BotThreadError("invalid_request");
      const owner = { type: "personal" as const, ownerId };
      return deps.chats.withTransaction(async (chats) => {
        await lockChatAgentOwner(chats.kysely, owner);
        const bot = await threadBot(ownerId, agentId);
        const db = ownerBotExecutor(chats.kysely);
        const existing = await db.selectFrom("chats").select("id")
          .where("owner_type", "=", owner.type).where("owner_id", "=", ownerId)
          .where("create_request_id", "=", request.data.clientRequestId)
          .executeTakeFirst();
        if (existing) {
          const bound = await bindings.boundBot({ ownerId, chatId: existing.id }, db);
          if (bound?.kind !== "thread" || bound.botId !== agentId || bound.projectId !== project.projectId) {
            throw new BotThreadError("conflict");
          }
          const record = await chats.get(owner, existing.id);
          if (!record) throw new BotThreadError("conflict");
          return { record: CanonicalChatRecordSchema.parse(record), operation: "replayed" as const };
        }
        if (await bindings.liveThreadCount({ ownerId, botId: agentId }, db) >= MAX_BOT_THREADS) {
          throw new BotThreadError("rate_limited");
        }
        const chatId = `chat_${randomUUID().replaceAll("-", "")}`;
        const record = await chats.create(owner, {
          id: chatId,
          clientRequestId: request.data.clientRequestId,
          title: request.data.title ?? DEFAULT_THREAD_TITLE,
          currentSelection: bot.selection,
        });
        if (record.chat.id !== chatId) throw new BotThreadError("conflict");
        try {
          await bindings.bindThread({ ownerId, botId: agentId, chatId, projectId: project.projectId, now: now() }, db);
        } catch (error: unknown) {
          if (error instanceof BotStateError) throw new BotThreadError(error.code === "not_found" ? "not_found" : "conflict");
          throw error;
        }
        return { record: CanonicalChatRecordSchema.parse(record), operation: "created" as const };
      });
    },

    /** The query is parsed at the route; only the cursor's own contents are checked here. */
    async list(ownerId: string, agentId: string, query: BotThreadListQuery): Promise<CanonicalChatListResponse> {
      await threadBot(ownerId, agentId);
      const page = await bindings.threadPage({
        ownerId, botId: agentId, projectId: query.projectId, limit: query.limit,
        ...(query.cursor ? { cursor: decodeCursor(query.cursor) } : {}),
      });
      const owner = { type: "personal" as const, ownerId };
      const records = await Promise.all(page.chatIds.map((chatId) => deps.chats.get(owner, chatId)));
      return CanonicalChatListResponseSchema.parse({
        items: records.filter((record) => record !== null),
        ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}),
      });
    },
  };
}

export type BotThreadService = ReturnType<typeof createBotThreads>;
