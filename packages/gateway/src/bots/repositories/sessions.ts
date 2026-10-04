/**
 * Pi transcripts per bot and chat (`bot_agent_sessions`). The gateway treats
 * messages as opaque JSON; the bot runtime owns their structure. Every save
 * is revision-checked in the write statement, so a stale worker cannot
 * overwrite a newer transcript.
 */
import { sql } from "kysely";
import { BotStateError, isChatOwnerViolation, isoTimestamp, newBotStateId, toSafeInteger, type BotExecutor } from "./shared.js";

/** Matches the broker's session cap on compact JSON. */
export const BOT_SESSION_MAX_BYTES = 512 * 1024;
const MAX_RUNTIME_VERSION_ENTRIES = 16;
const encoder = new TextEncoder();

export interface BotSessionSnapshot {
  revision: number;
  messages: Record<string, unknown>[];
  compactedThroughSeq: number | null;
  needsRecompaction: boolean;
  updatedAt: string | null;
}

export interface BotSessionKey {
  ownerId: string;
  botId: string;
  chatId: string;
}

export function assertRuntimeVersions(versions: Record<string, string>): void {
  const entries = Object.entries(versions);
  if (entries.length > MAX_RUNTIME_VERSION_ENTRIES
    || entries.some(([key, value]) => !/^[a-z@][a-z0-9@/._-]{0,127}$/.test(key) || !/^[A-Za-z0-9._+-]{1,128}$/.test(value))) {
    throw new BotStateError("invalid_input");
  }
}

export function createBotSessionsRepository(db: BotExecutor) {
  return {
    /** A chat with no saved transcript loads as revision 0 with no messages. */
    async load(key: BotSessionKey, executor: BotExecutor = db): Promise<BotSessionSnapshot> {
      const row = await executor.selectFrom("bot_agent_sessions")
        .select(["messages", "revision", "compacted_through_seq", "needs_recompaction", "updated_at"])
        .where("owner_id", "=", key.ownerId).where("bot_id", "=", key.botId).where("chat_id", "=", key.chatId)
        .executeTakeFirst();
      if (!row) return { revision: 0, messages: [], compactedThroughSeq: null, needsRecompaction: false, updatedAt: null };
      const messages = typeof row.messages === "string" ? JSON.parse(row.messages) as unknown : row.messages;
      return {
        revision: toSafeInteger(row.revision),
        messages: Array.isArray(messages) ? messages as Record<string, unknown>[] : [],
        compactedThroughSeq: row.compacted_through_seq === null ? null : toSafeInteger(row.compacted_through_seq),
        needsRecompaction: row.needs_recompaction,
        updatedAt: isoTimestamp(row.updated_at),
      };
    },
    /**
     * Saves a transcript at `baseRevision`: 0 creates it, any other value must
     * match the stored revision. Returns the new revision. A save that carries
     * a compaction point or invalidation acknowledgement also clears the flag.
     */
    async save(input: BotSessionKey & {
      baseRevision: number;
      messages: readonly Record<string, unknown>[];
      compactedThroughSeq?: number;
      recompactionHandled?: true;
      tokenEstimate: number;
      runtimeVersions: Record<string, string>;
      now: string;
    }, executor: BotExecutor = db): Promise<{ revision: number }> {
      const encoded = JSON.stringify(input.messages);
      if (encoder.encode(encoded).byteLength > BOT_SESSION_MAX_BYTES) throw new BotStateError("too_large");
      if (!Number.isSafeInteger(input.tokenEstimate) || input.tokenEstimate < 0) throw new BotStateError("invalid_input");
      assertRuntimeVersions(input.runtimeVersions);
      const runtimeVersions = JSON.stringify(input.runtimeVersions);
      if (input.baseRevision === 0) {
        const inserted = await executor.insertInto("bot_agent_sessions").values({
          session_id: newBotStateId("bses"),
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          messages: encoded,
          compacted_through_seq: input.compactedThroughSeq ?? null,
          token_estimate: input.tokenEstimate,
          runtime_versions: runtimeVersions,
          revision: 1,
          updated_at: input.now,
        }).onConflict((conflict) => conflict.columns(["owner_id", "bot_id", "chat_id"]).doNothing())
          .returning("revision")
          .executeTakeFirst()
          .catch((error: unknown) => {
            if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
            throw error;
          });
        if (!inserted) throw new BotStateError("revision_conflict");
        return { revision: toSafeInteger(inserted.revision) };
      }
      const updated = await executor.updateTable("bot_agent_sessions")
        .set({
          messages: encoded,
          token_estimate: input.tokenEstimate,
          runtime_versions: runtimeVersions,
          revision: sql<number>`revision + 1`,
          updated_at: input.now,
          // Only the revision-checked save can acknowledge discarded derived summaries.
          ...(input.recompactionHandled ? { needs_recompaction: false } : {}),
          // A save that carries a compaction point replaces the summary, so it clears the flag.
          ...(input.compactedThroughSeq !== undefined
            ? { compacted_through_seq: input.compactedThroughSeq, needs_recompaction: false }
            : {}),
        })
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId).where("chat_id", "=", input.chatId)
        .where("revision", "=", input.baseRevision)
        .returning("revision")
        .executeTakeFirst();
      if (!updated) throw new BotStateError("revision_conflict");
      return { revision: toSafeInteger(updated.revision) };
    },
    /**
     * Flags every transcript of a bot for regeneration, e.g. after a memory
     * item is forgotten. The revision advances, so a worker holding an older
     * copy cannot save over the flag; it must reload and see it. Every forget
     * advances the revision, even while an earlier invalidation is pending.
     */
    async markNeedsRecompaction(input: { ownerId: string; botId: string; now: string }, executor: BotExecutor = db): Promise<number> {
      const rows = await executor.updateTable("bot_agent_sessions")
        .set({ needs_recompaction: true, revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("bot_id", "=", input.botId)
        .returning("session_id")
        .execute();
      return rows.length;
    },
  };
}

export type BotSessionsRepository = ReturnType<typeof createBotSessionsRepository>;
