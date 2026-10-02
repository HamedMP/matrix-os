/** Durable answer delivery, independent of integrations. Resolution stores the text in
 * the interaction transaction. Successful admission or exact owner cancellation acknowledges
 * it; stable request IDs make a restart between admission and acknowledgment safe. */
import { BotInteractionIdSchema } from "@matrix-os/contracts";
import { sql } from "kysely";
import type { BotStateTransactions } from "./events.js";
import { BotInteractionError, type BotContinuation } from "./interactions.js";

const MAX_CONTINUATIONS_PER_OWNER = 100;
const CONTINUATION_RETRY_MS = 60_000;

export function createBotInteractionContinuations(deps: { transact: BotStateTransactions; now?: () => Date }) {
  const now = () => deps.now?.() ?? new Date();
  return {
    /** Resolved answers awaiting Chat admission survive process restarts. */
    async pendingContinuations(ownerId: string): Promise<BotContinuation[]> {
      const at = now().toISOString();
      const rows = await deps.transact(ownerId, (tx) => tx.db.selectFrom("bot_interactions")
        .select(["interaction_id", "chat_id", "resolution"])
        .where("owner_id", "=", ownerId).where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`)
        .where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt' OR resolution ? 'continuationCancelledAt')`)
        .where(sql<boolean>`(resolution->>'continuationRetryAt' IS NULL OR resolution->>'continuationRetryAt' <= ${at})`)
        .orderBy("created_at", "asc").limit(MAX_CONTINUATIONS_PER_OWNER).execute());
      return rows.flatMap((row) => {
        const text = row.resolution?.continuation;
        return typeof text === "string" && text.length > 0
          ? [{ chatId: row.chat_id, clientRequestId: `req_answer_${row.interaction_id}`, text }]
          : [];
      });
    },
    /** Admission is idempotent under the interaction-derived request ID. */
    async ackContinuation(ownerId: string, clientRequestId: string, outcome?: "cancelled"): Promise<void> {
      const id = BotInteractionIdSchema.safeParse(clientRequestId.replace(/^req_answer_/, ""));
      if (!id.success || clientRequestId !== `req_answer_${id.data}`) throw new BotInteractionError("invalid_request");
      const at = now().toISOString();
      const field = outcome === "cancelled" ? "continuationCancelledAt" : "continuationAdmittedAt";
      await deps.transact(ownerId, (tx) => tx.db.updateTable("bot_interactions")
        .set({ resolution: sql`jsonb_set(resolution, ARRAY[${field}]::text[], to_jsonb(${at}::text), true)` })
        .where("owner_id", "=", ownerId).where("interaction_id", "=", id.data)
        .where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`).where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt' OR resolution ? 'continuationCancelledAt')`)
        .execute());
    },
    /** Delay a failed admission so one owner cannot monopolize every bounded pass. */
    async deferContinuation(ownerId: string, clientRequestId: string): Promise<void> {
      const id = BotInteractionIdSchema.safeParse(clientRequestId.replace(/^req_answer_/, ""));
      if (!id.success || clientRequestId !== `req_answer_${id.data}`) throw new BotInteractionError("invalid_request");
      const retryAt = new Date(now().getTime() + CONTINUATION_RETRY_MS).toISOString();
      await deps.transact(ownerId, (tx) => tx.db.updateTable("bot_interactions")
        .set({ resolution: sql`jsonb_set(resolution, '{continuationRetryAt}', to_jsonb(${retryAt}::text), true)` })
        .where("owner_id", "=", ownerId).where("interaction_id", "=", id.data)
        .where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`).where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt' OR resolution ? 'continuationCancelledAt')`)
        .execute());
    },

    async ownersWithPending(): Promise<string[]> {
      const at = now().toISOString();
      const rows = await deps.transact("bot-continuation-reconcile", (tx) => tx.db.selectFrom("bot_interactions")
        .select("owner_id").select((eb) => eb.fn.min("created_at").as("oldest"))
        .where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`)
        .where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt' OR resolution ? 'continuationCancelledAt')`)
        .where(sql<boolean>`(resolution->>'continuationRetryAt' IS NULL OR resolution->>'continuationRetryAt' <= ${at})`)
        .groupBy("owner_id").orderBy("oldest", "asc").orderBy("owner_id", "asc")
        .limit(16).execute());
      return rows.map((row) => row.owner_id);
    },
  };
}
