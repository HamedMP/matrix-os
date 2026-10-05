/**
 * Bot state writes and their canonical Chat events commit together (spec
 * 536, contracts/chat-events.md). A write runs inside the chat repository's
 * transaction; events it publishes go to the chat outbox in that same
 * transaction and are delivered only after commit. Payloads carry IDs and
 * allowlisted state only; clients refetch details through authorized reads.
 */
import type { ChatRepository } from "../chat/repository.js";
import { ownerBotExecutor } from "./instantiation.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";

export type BotChatEventType =
  | "bot.created"
  | "interaction.requested"
  | "interaction.resolved"
  | "bot.task.updated"
  | "bot.authority.changed"
  | "bot.memory.remembered";

export interface BotStateTransaction {
  db: BotExecutor;
  /** Queues an event for the owner's chat; it is delivered only if the transaction commits. */
  publish(chatId: string, eventType: BotChatEventType, payload: Record<string, string | number | boolean | null>): Promise<void>;
}

export type BotStateTransactions = <T>(ownerId: string, work: (tx: BotStateTransaction) => Promise<T>) => Promise<T>;

export function createBotStateTransactions(chats: Pick<ChatRepository, "withTransaction">): BotStateTransactions {
  return (ownerId, work) => chats.withTransaction(async (repository) => {
    const db = ownerBotExecutor(repository.kysely);
    const owner = { type: "personal" as const, ownerId };
    return work({
      db,
      async publish(chatId, eventType, payload) {
        // Bot events carry the chat's current revision; they do not change the chat itself.
        const chat = await db.selectFrom("chats").select("revision")
          .where("id", "=", chatId).where("owner_type", "=", "personal").where("owner_id", "=", ownerId)
          .executeTakeFirst();
        if (!chat) throw new BotStateError("not_found");
        await repository.appendOutboxEvent(owner, chatId, Number(chat.revision), eventType, payload);
      },
    });
  });
}
