import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "./database.js";
import { ChatConflictError } from "./errors.js";

/** Caller holds owner/chat and queued-row locks in the queue-cancellation transaction. */
export async function releaseTerminalQueuedSteer(db: Kysely<ChatDatabase> | Transaction<ChatDatabase>, input: {
  chatId: string; queuedTurnId: string; revision: number; cancelledAt: string;
}): Promise<void> {
  const pending = await db.selectFrom("chat_run_steers").select(["id", "run_id"])
    .where("chat_id", "=", input.chatId).where("queued_turn_id", "=", input.queuedTurnId)
    .where("status", "=", "pending").limit(2).execute();
  if (pending.length === 0) return;
  // Admission permits one pending attempt. Unexpected multiplicity fails closed.
  if (pending.length !== 1) throw new ChatConflictError(input.chatId, input.revision);
  const source = await db.selectFrom("chat_runs").select("status")
    .where("chat_id", "=", input.chatId).where("id", "=", pending[0]!.run_id).executeTakeFirst();
  if (!source || !["completed", "failed", "aborted"].includes(source.status)) {
    throw new ChatConflictError(input.chatId, input.revision);
  }
  await db.updateTable("chat_run_steers").set({ status: "failed", updated_at: input.cancelledAt })
    .where("id", "=", pending[0]!.id).where("status", "=", "pending").executeTakeFirstOrThrow();
}
