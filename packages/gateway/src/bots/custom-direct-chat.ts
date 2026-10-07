import { createHash } from "node:crypto";
import { CanonicalOwnerScopeSchema, ChatAgentIdSchema } from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import type { BotChatLookup } from "../chat/agent-context.js";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatOwner } from "../chat/records.js";
import { ownerBotExecutor } from "./instantiation.js";
import { createBotBindingsRepository, type BotBindingsRepository } from "./repositories/bindings.js";

export class BotEntryError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "unavailable") { super(code); this.name = "BotEntryError"; }
}

/** Versioned, owner-scoped adaptation on explicit opening; definitions and grants stay unchanged. */
export function createCustomBotChats(options: {
  chats: Pick<ChatRepository, "kysely" | "withTransaction">;
  agents: Pick<ChatAgentStore, "get">;
  bindDirect?: BotBindingsRepository["bindDirect"];
}): BotChatLookup & { ensureDirectChat(owner: ChatOwner, agentId: string): Promise<string> } {
  const bindings = createBotBindingsRepository(ownerBotExecutor(options.chats.kysely));
  const personal = (owner: ChatOwner) => {
    const parsed = CanonicalOwnerScopeSchema.parse(owner);
    if (parsed.type !== "personal") throw new BotEntryError("not_found");
    return parsed;
  };
  const activeChat = async (chats: ChatRepository, owner: ChatOwner, chatId: string) => {
    const record = await chats.get(owner, chatId);
    if (!record || record.chat.lifecycle !== "active" || record.chat.collaboration) throw new BotEntryError("conflict");
    return record;
  };
  return {
    async directChat(owner, agentId) {
      if (owner.type !== "personal") return null;
      const agent = await options.agents.get(owner, ChatAgentIdSchema.parse(agentId));
      if (!agent || agent.archived) return null;
      const chatId = await bindings.directChatId({ ownerId: owner.ownerId, botId: agentId });
      if (!chatId) return null;
      const chat = await options.chats.kysely.selectFrom("chats").select("id").where("id", "=", chatId)
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
        .where("lifecycle", "=", "active").where("collaboration", "is", null).executeTakeFirst();
      return chat?.id ?? null;
    },
    async directBot(owner, chatId) {
      if (owner.type !== "personal") return null;
      const bound = await bindings.forChat({ ownerId: owner.ownerId, chatId });
      return bound.find(binding => binding.kind === "direct")?.botId ?? null;
    },
    async ensureDirectChat(ownerInput, agentIdInput) {
      const owner = personal(ownerInput), agentId = ChatAgentIdSchema.parse(agentIdInput);
      return options.chats.withTransaction(async chats => {
        await lockChatAgentOwner(chats.kysely, owner);
        const agent = await options.agents.get(owner, agentId);
        if (!agent || agent.archived) throw new BotEntryError("not_found");
        const db = ownerBotExecutor(chats.kysely);
        const existing = await bindings.directChatId({ ownerId: owner.ownerId, botId: agentId }, db);
        if (existing) { await activeChat(chats, owner, existing); return existing; }
        // Recipe creation owns its binding; a missing binding is a recovery problem.
        if (agent.recipeRef) throw new BotEntryError("unavailable");
        // A removed binding must never resurrect a deliberately removed identity.
        const removed = await db.selectFrom("bot_chat_bindings").select("chat_id")
          .where("owner_id", "=", owner.ownerId).where("bot_id", "=", agentId).where("kind", "=", "direct").limit(1).executeTakeFirst();
        if (removed) throw new BotEntryError("conflict");
        const digest = createHash("sha256").update(JSON.stringify(["custom-direct-v1", owner.ownerId, agentId])).digest("hex");
        const chatId = `chat_${digest}`, clientRequestId = `req_${digest}`;
        // Canonical hard-delete cascades bindings but retains this owner-scoped tombstone.
        const deleted = await db.selectFrom("chat_deletions").select("chat_id")
          .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
          .where("chat_id", "=", chatId).limit(1).executeTakeFirst();
        if (deleted) throw new BotEntryError("conflict");
        // Creation retries are safe only through an existing live Bot binding.
        // Never adopt an ordinary Chat occupying the deterministic ID or request key.
        const occupied = await db.selectFrom("chats").select("id")
          .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId)
          .where(eb => eb.or([eb("id", "=", chatId), eb("create_request_id", "=", clientRequestId)]))
          .limit(1).executeTakeFirst();
        if (occupied) throw new BotEntryError("conflict");
        const record = await chats.create(owner, { id: chatId, clientRequestId, title: agent.name, currentSelection: agent.selection });
        if (record.chat.id !== chatId) throw new BotEntryError("conflict");
        await activeChat(chats, owner, record.chat.id);
        await (options.bindDirect ?? bindings.bindDirect)({ ownerId: owner.ownerId, botId: agentId, chatId: record.chat.id, now: new Date().toISOString() }, db);
        await chats.appendOutboxEvent(owner, record.chat.id, record.chat.revision, "bot.created", { agentId, chatId: record.chat.id, revision: agent.revision });
        return record.chat.id;
      });
    },
  };
}
