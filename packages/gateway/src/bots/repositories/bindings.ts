/**
 * Bot-to-chat bindings (`bot_chat_bindings`). Each bot has at most one live
 * direct chat (partial unique index); group bindings arrive in M3. A thread
 * (spec 567) is one more Chat of a bot, fixed to one project when it is bound.
 */
import { sql, type Selectable } from "kysely";
import type { BotChatBindingsTable } from "../database.js";
import { BotStateError, isChatOwnerViolation, isUniqueViolation, isoTimestamp, optionalIsoTimestamp, type BotExecutor } from "./shared.js";

const MAX_BINDINGS_PER_CHAT = 16;
/** Chat ids one Bot chat lookup may ask about (a page of the brain chat picker is 100). */
const MAX_BOT_CHAT_LOOKUP = 200;

export interface BotChatBinding {
  ownerId: string;
  botId: string;
  chatId: string;
  kind: "direct" | "group" | "thread";
  /** The project a thread reads; null for direct and group bindings. */
  projectId: string | null;
  createdAt: string;
  removedAt: string | null;
}

/** The bot a Chat belongs to: its direct Chat or one of its threads. */
export interface BoundBot {
  botId: string;
  kind: "direct" | "thread";
  projectId: string | null;
}

/** Newest activity first, as `GET /api/chats` orders Chats. */
export interface BotThreadCursor {
  activityAt: string;
  chatId: string;
}

function fromRow(row: Selectable<BotChatBindingsTable>): BotChatBinding {
  return {
    ownerId: row.owner_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    kind: row.kind,
    projectId: row.project_id ?? null,
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
    /**
     * Binds a new thread Chat to its bot and project. Idempotent for the same
     * live thread; any other binding of that bot and Chat is a conflict.
     */
    async bindThread(input: { ownerId: string; botId: string; chatId: string; projectId: string; now: string }, executor: BotExecutor = db): Promise<BotChatBinding> {
      try {
        const written = await executor.insertInto("bot_chat_bindings").values({
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          kind: "thread",
          project_id: input.projectId,
          created_at: input.now,
          removed_at: null,
        }).onConflict((conflict) => conflict.columns(["owner_id", "bot_id", "chat_id"]).doNothing())
          .returningAll()
          .executeTakeFirst();
        if (written) return fromRow(written);
      } catch (error: unknown) {
        if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
        // check_violation: the project does not match the thread project pattern.
        if (error instanceof Error && "code" in error && error.code === "23514") throw new BotStateError("invalid_input");
        throw error;
      }
      const existing = await executor.selectFrom("bot_chat_bindings").selectAll()
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .executeTakeFirst();
      if (!existing || existing.kind !== "thread" || existing.project_id !== input.projectId || existing.removed_at !== null) {
        throw new BotStateError("conflict");
      }
      return fromRow(existing);
    },
    /** The bot of a Chat: its live direct or thread binding, oldest first. */
    async boundBot(input: { ownerId: string; chatId: string }, executor: BotExecutor = db): Promise<BoundBot | null> {
      const row = await executor.selectFrom("bot_chat_bindings").select(["bot_id", "kind", "project_id"])
        .where("owner_id", "=", input.ownerId).where("chat_id", "=", input.chatId)
        .where("kind", "in", ["direct", "thread"]).where("removed_at", "is", null)
        .orderBy("created_at", "asc").orderBy("bot_id", "asc")
        .executeTakeFirst();
      if (!row || (row.kind !== "direct" && row.kind !== "thread")) return null;
      return { botId: row.bot_id, kind: row.kind, projectId: row.project_id ?? null };
    },
    /** The Chats among `chatIds` with a live direct or thread binding: a Bot's own Chats. */
    async botChatIds(input: { ownerId: string; chatIds: readonly string[] }, executor: BotExecutor = db): Promise<Set<string>> {
      if (input.chatIds.length === 0) return new Set();
      if (input.chatIds.length > MAX_BOT_CHAT_LOOKUP) throw new RangeError("Too many chat ids");
      const rows = await executor.selectFrom("bot_chat_bindings").select("chat_id")
        .where("owner_id", "=", input.ownerId).where("chat_id", "in", [...input.chatIds])
        .where("kind", "in", ["direct", "thread"]).where("removed_at", "is", null)
        .execute();
      return new Set(rows.map((row) => row.chat_id));
    },
    async liveThreadCount(input: { ownerId: string; botId: string }, executor: BotExecutor = db): Promise<number> {
      const row = await executor.selectFrom("bot_chat_bindings").select(sql<string>`count(*)`.as("count"))
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .where("kind", "=", "thread").where("removed_at", "is", null)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },
    /** One page of a bot's live threads for one project, newest Chat activity first. */
    async threadPage(input: {
      ownerId: string; botId: string; projectId: string; limit: number; cursor?: BotThreadCursor;
    }, executor: BotExecutor = db): Promise<{ chatIds: string[]; next?: BotThreadCursor }> {
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
      let query = executor.selectFrom("bot_chat_bindings as binding")
        .innerJoin("chats as chat", "chat.id", "binding.chat_id")
        .select(["chat.id as chatId", sql<string>`to_char(chat.activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("activityAt")])
        .where("binding.owner_id", "=", input.ownerId).where("binding.bot_id", "=", input.botId)
        .where("binding.kind", "=", "thread").where("binding.project_id", "=", input.projectId)
        .where("binding.removed_at", "is", null)
        .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", input.ownerId)
        .where("chat.lifecycle", "=", "active");
      if (input.cursor) {
        const at = sql<Date>`${input.cursor.activityAt}::timestamptz`;
        const chatId = input.cursor.chatId;
        query = query.where(({ and, eb, or }) => or([
          eb("chat.activity_at", "<", at),
          and([eb("chat.activity_at", "=", at), eb("chat.id", ">", chatId)]),
        ]));
      }
      const rows = await query.orderBy("chat.activity_at", "desc").orderBy("chat.id", "asc").limit(limit + 1).execute();
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? page.at(-1) : undefined;
      return { chatIds: page.map((row) => row.chatId), ...(last ? { next: { activityAt: last.activityAt, chatId: last.chatId } } : {}) };
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

/**
 * The owner's Bot Chats among `chatIds`, for the Company Brain chat source (spec 567). Before the Bot tables exist (no
 * Bot has started on this database) no Chat is a Bot's; any other failure is thrown.
 */
export function createBotChatIdsLookup(db: BotExecutor) {
  const bindings = createBotBindingsRepository(db);
  return async (ownerId: string, chatIds: readonly string[]): Promise<ReadonlySet<string>> => {
    try {
      return await bindings.botChatIds({ ownerId, chatIds });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "42P01") return new Set();
      throw error;
    }
  };
}
