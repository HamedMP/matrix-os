import { sql } from "kysely";
import type { BotStateTransaction } from "./events.js";
import type { RoutineCliScope } from "./repositories/routine-cli-preferences.js";
/** Recovery reads only the immutable direct receipt and its REAL approval/task. No fabricated dispatch revision. */
export async function recoverExistingRoutineProposal(tx: BotStateTransaction, scope: RoutineCliScope, input: { ownerId: string; taskId: string; chatId?: string; runId?: string }) {
  const rows = await tx.db.selectFrom("routine_cli_requests as q").innerJoin("bot_interactions as i", join => join.onRef("i.interaction_id", "=", sql<string>`q.admission ->> 'interactionId'`))
    .innerJoin("bot_approvals as a", "a.approval_id", "i.interaction_id").innerJoin("bot_tasks as t", "t.task_id", "i.task_id")
    .select(["i.status", "t.status as task_status", "i.source_run_id", "t.run_id", "i.chat_id"])
    .where("q.owner_id", "=", input.ownerId).where("q.computer_id", "=", scope.computerId)
    .where(sql<boolean>`q.admission ->> 'disposition' = 'pending_approval' AND q.operation ->> 'operation' = 'propose' AND q.source_context -> 'identity' ->> 'kind' = 'bot_child'`)
    .where(sql<boolean>`q.source_context -> 'identity' ->> 'taskId' = ${input.taskId}`)
    .where(sql<boolean>`q.source_context -> 'identity' ->> 'runId' = i.source_run_id AND q.target_snapshot ->> 'chatId' = i.chat_id AND q.target_snapshot ->> 'botId' = i.bot_id`)
    .whereRef("i.owner_id", "=", "q.owner_id").whereRef("a.owner_id", "=", "q.owner_id").whereRef("t.owner_id", "=", "q.owner_id")
    .whereRef("a.bot_id", "=", "i.bot_id").whereRef("t.bot_id", "=", "i.bot_id").whereRef("t.chat_id", "=", "i.chat_id")
    .whereRef("a.task_id", "=", "i.task_id").whereRef("a.run_id", "=", "i.source_run_id")
    .where("i.kind", "=", "approval").where("i.responder_actor_id", "=", input.ownerId).where("a.tool", "=", "routine.activate").limit(2).execute();
  const row = rows[0];
  return input.ownerId === scope.ownerId && rows.length === 1 && !!row && (!input.chatId || row.chat_id === input.chatId)
    && (!input.runId || row.source_run_id === input.runId)
    && (row.status !== "pending" || row.task_status === "waiting_person" && row.run_id === row.source_run_id);
}
