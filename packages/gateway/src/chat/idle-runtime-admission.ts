import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import type { IdleWorkspaceIdentity } from "../coding-agents/idle-workspace-state.js";

/** Lock the canonical Chat row across the bounded local stop, excluding concurrent queue/run admission. */
export async function withCanonicalIdleChat(
  database: Kysely<ChatDatabase>,
  identity: IdleWorkspaceIdentity,
  reclaim: () => Promise<boolean>,
): Promise<boolean> {
  return database.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
    const matches = await trx.selectFrom("chats").select("chats.id")
      .where("owner_type", "=", "personal").where("owner_id", "=", identity.ownerId)
      .where("bound_driver_kind", "=", "codex")
      .where((eb) => eb.exists(eb.selectFrom("chat_run_adapter_state as adapter")
        .innerJoin("chat_runs as run", "run.id", "adapter.run_id").select("run.id")
        .whereRef("run.chat_id", "=", "chats.id").where("adapter.driver_kind", "=", "codex")
        .where(sql<string>`adapter.state->>'conversationId'`, "=", identity.threadId)))
      .limit(2).forUpdate().execute();
    // Forks or missing provenance cannot safely authorize runtime reclamation.
    if (matches.length !== 1) return false;
    const chatId = matches[0].id;
    const active = await trx.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId)
      .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"]).executeTakeFirst();
    const queued = await trx.selectFrom("chat_queued_turns").select("id").where("chat_id", "=", chatId)
      .where("status", "=", "queued").executeTakeFirst();
    const pendingSteer = await trx.selectFrom("chat_run_steers").select("id").where("chat_id", "=", chatId)
      .where("status", "=", "pending").executeTakeFirst();
    if (active || queued || pendingSteer) return false;
    return reclaim();
  });
}
