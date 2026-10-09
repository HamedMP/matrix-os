/**
 * Bot-to-chat bindings (`bot_chat_bindings`). Each bot has at most one live
 * direct chat (partial unique index); group bindings arrive in M3.
 */
import type { Selectable } from "kysely";
import type { BotChatBindingsTable } from "../database.js";
import { BotStateError, isChatOwnerViolation, isUniqueViolation, isoTimestamp, optionalIsoTimestamp, type BotExecutor } from "./shared.js";

const MAX_BINDINGS_PER_CHAT = 16;

export interface BotChatBinding {
  ownerId: string;
  botId: string;
  chatId: string;
  kind: "direct" | "group";
  createdAt: string;
  removedAt: string | null;
}

function fromRow(row: Selectable<BotChatBindingsTable>): BotChatBinding {
  return {
    ownerId: row.owner_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    kind: row.kind,
    createdAt: isoTimestamp(row.created_at),
    removedAt: optionalIsoTimestamp(row.removed_at),
  };
}

export function createBotBindingsRepository(db: BotExecutor) {
  return {
    /**
     * Binds a bot to its direct chat, which the owner must own. Idempotent for
     * the same chat, and restores a removed binding to it; a second live
     * direct chat for the bot is a conflict.
     */
    async bindDirect(input: { ownerId: string; botId: string; chatId: string; now: string }, executor: BotExecutor = db): Promise<BotChatBinding> {
      try {
        const written = await executor.insertInto("bot_chat_bindings").values({
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          kind: "direct",
          created_at: input.now,
          removed_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_id", "bot_id", "chat_id"])
          .doUpdateSet({ removed_at: null, created_at: input.now })
          .where("bot_chat_bindings.kind", "=", "direct")
          .where("bot_chat_bindings.removed_at", "is not", null))
          .returningAll()
          .executeTakeFirst();
        if (written) return fromRow(written);
      } catch (error: unknown) {
        if (isUniqueViolation(error, "idx_bot_chat_bindings_one_direct")) throw new BotStateError("conflict");
        if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
        throw error;
      }
      const existing = await executor.selectFrom("bot_chat_bindings").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .executeTakeFirst();
      if (!existing || existing.kind !== "direct" || existing.removed_at !== null) throw new BotStateError("conflict");
      return fromRow(existing);
    },
    /** Caller must authorize group membership and bot consent before binding; never converts a direct chat. */
    async bindGroup(input: { ownerId: string; botId: string; chatId: string; now: string }, executor: BotExecutor = db): Promise<BotChatBinding> {
      try {
        const written = await executor.insertInto("bot_chat_bindings").values({
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          kind: "group",
          created_at: input.now,
          removed_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_id", "bot_id", "chat_id"])
          .doUpdateSet({ removed_at: null, created_at: input.now })
          .where("bot_chat_bindings.kind", "=", "group")
          .where("bot_chat_bindings.removed_at", "is not", null))
          .returningAll()
          .executeTakeFirst();
        if (written) return fromRow(written);
      } catch (error: unknown) {
        if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
        throw error;
      }
      const existing = await executor.selectFrom("bot_chat_bindings").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .executeTakeFirst();
      if (!existing || existing.kind !== "group" || existing.removed_at !== null) throw new BotStateError("conflict");
      return fromRow(existing);
    },
    async directChatId(input: { ownerId: string; botId: string }, executor: BotExecutor = db): Promise<string | undefined> {
      const row = await executor.selectFrom("bot_chat_bindings").select("chat_id")
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .where("kind", "=", "direct").where("removed_at", "is", null)
        .executeTakeFirst();
      return row?.chat_id;
    },
    /** Live bindings for one chat, bounded. */
    async forChat(input: { ownerId: string; chatId: string }, executor: BotExecutor = db): Promise<BotChatBinding[]> {
      const rows = await executor.selectFrom("bot_chat_bindings").selectAll()
        .where("owner_id", "=", input.ownerId).where("chat_id", "=", input.chatId).where("removed_at", "is", null)
        .orderBy("created_at", "asc")
        .limit(MAX_BINDINGS_PER_CHAT)
        .execute();
      return rows.map(fromRow);
    },
    /** Returns false when the binding was already removed or never existed. */
    async remove(input: { ownerId: string; botId: string; chatId: string; now: string }, executor: BotExecutor = db): Promise<boolean> {
      const row = await executor.updateTable("bot_chat_bindings").set({ removed_at: input.now })
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .where("removed_at", "is", null)
        .returning("chat_id")
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

export type BotBindingsRepository = ReturnType<typeof createBotBindingsRepository>;
