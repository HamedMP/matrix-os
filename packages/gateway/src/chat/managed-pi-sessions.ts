/**
 * Owned Pi transcripts per owner and Chat (`managed_pi_sessions`). The gateway treats
 * messages as opaque JSON; the pinned Pi runtime owns their structure. Every save
 * is revision-checked in the write statement, so a stale worker cannot
 * overwrite a newer transcript.
 */
import { assertRuntimeVersions, BOT_SESSION_MAX_BYTES } from "../bots/repositories/sessions.js";
import { sql } from "kysely";
import { BotStateError, isChatOwnerViolation, isoTimestamp, newBotStateId, toSafeInteger, type BotExecutor } from "../bots/repositories/shared.js";

const encoder = new TextEncoder();

export interface ManagedPiSessionSnapshot {
  revision: number;
  messages: Record<string, unknown>[];
  compactedThroughSeq: number | null;
  needsRecompaction: boolean;
  updatedAt: string | null;
}

export interface ManagedPiSessionKey {
  ownerId: string;
  chatId: string;
}

export function createManagedPiSessionsRepository(db: BotExecutor) {
  return {
    /** A chat with no saved transcript loads as revision 0 with no messages. */
    async load(key: ManagedPiSessionKey, executor: BotExecutor = db): Promise<ManagedPiSessionSnapshot> {
      const row = await executor.selectFrom("managed_pi_sessions")
        .select(["messages", "revision", "compacted_through_seq", "needs_recompaction", "updated_at"])
        .where("owner_id", "=", key.ownerId).where("chat_id", "=", key.chatId)
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
     * a compaction point also clears the recompaction flag.
     */
    async save(input: ManagedPiSessionKey & {
      baseRevision: number;
      messages: readonly Record<string, unknown>[];
      compactedThroughSeq?: number;
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
        const inserted = await executor.insertInto("managed_pi_sessions").values({
          session_id: newBotStateId("bses"),
          owner_id: input.ownerId,
          chat_id: input.chatId,
          messages: encoded,
          compacted_through_seq: input.compactedThroughSeq ?? null,
          token_estimate: input.tokenEstimate,
          runtime_versions: runtimeVersions,
          revision: 1,
          updated_at: input.now,
        }).onConflict((conflict) => conflict.columns(["owner_id", "chat_id"]).doNothing())
          .returning("revision")
          .executeTakeFirst()
          .catch((error: unknown) => {
            if (isChatOwnerViolation(error)) throw new BotStateError("not_found");
            throw error;
          });
        if (!inserted) throw new BotStateError("revision_conflict");
        return { revision: toSafeInteger(inserted.revision) };
      }
      const updated = await executor.updateTable("managed_pi_sessions")
        .set({
          messages: encoded,
          token_estimate: input.tokenEstimate,
          runtime_versions: runtimeVersions,
          revision: sql<number>`revision + 1`,
          updated_at: input.now,
          // A save that carries a compaction point replaces the summary, so it clears the flag.
          ...(input.compactedThroughSeq !== undefined
            ? { compacted_through_seq: input.compactedThroughSeq, needs_recompaction: false }
            : {}),
        })
        .where("owner_id", "=", input.ownerId).where("chat_id", "=", input.chatId)
        .where("revision", "=", input.baseRevision)
        .returning("revision")
        .executeTakeFirst();
      if (!updated) throw new BotStateError("revision_conflict");
      return { revision: toSafeInteger(updated.revision) };
    },
  };
}

export type ManagedPiSessionsRepository = ReturnType<typeof createManagedPiSessionsRepository>;
