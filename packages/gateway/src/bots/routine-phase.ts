import type { BotExecutor } from "./repositories/shared.js";
import { sql } from "kysely";
import { isoTimestamp } from "./repositories/shared.js";
import type { BotRoutine } from "./repositories/routines.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import { routineApprovalDigest } from "./routine-authorization.js";
import { BotBrokerActionError } from "./broker-actions.js";

/** One fresh durable snapshot after external source validation; no lock spans that I/O. */
export async function assertCurrentRoutinePhase(db: BotExecutor, binding: BotRuntimeBinding, routine: BotRoutine, now: () => string) {
  const source = routine.authorization;
  if (!source || !routine.approvalId) throw new BotBrokerActionError("not_granted");
  const current = await db.selectFrom("bot_routine_fires as fire")
    .innerJoin("bot_routines as routine", join => join.onRef("routine.owner_id", "=", "fire.owner_id").onRef("routine.routine_id", "=", "fire.routine_id"))
    .innerJoin("bot_tasks as task", join => join.onRef("task.owner_id", "=", "fire.owner_id").onRef("task.task_id", "=", "fire.task_id"))
    .innerJoin("bot_approvals as approval", join => join.onRef("approval.owner_id", "=", "routine.owner_id").onRef("approval.approval_id", "=", "routine.approval_id"))
    .innerJoin("chats as chat", "chat.id", "routine.chat_id")
    .innerJoin("bot_chat_bindings as direct", join => join.onRef("direct.owner_id", "=", "routine.owner_id").onRef("direct.bot_id", "=", "routine.bot_id").onRef("direct.chat_id", "=", "routine.chat_id"))
    .select(["fire.lease_expires_at", "fire.fire_id"])
    .where("fire.owner_id", "=", binding.ownerId).where("fire.task_id", "=", binding.taskId).where("fire.status", "=", "dispatched")
    .where("routine.routine_id", "=", routine.routineId).where("routine.bot_id", "=", binding.botId).where("routine.chat_id", "=", binding.chatId)
    .where("routine.status", "=", "active").where("routine.revision", "=", routine.revision)
    .where(sql<boolean>`routine.approved_source = ${JSON.stringify(source)}::jsonb AND routine.proposal = ${JSON.stringify(routine.proposal)}::jsonb`)
    .where("routine.approval_id", "=", routine.approvalId)
    .where("task.bot_id", "=", binding.botId).where("task.chat_id", "=", binding.chatId).where("task.run_id", "=", binding.runId).where("task.status", "=", "running")
    .where("approval.bot_id", "=", binding.botId).where("approval.status", "=", "approved").where("approval.claimed_at", "is not", null)
    .where("approval.tool", "=", "routine.activate").where("approval.args_hash", "=", routineApprovalDigest(routine.proposal, source))
    .where("approval.account", "=", source.accountId).where("approval.policy_revision", "=", source.grantRevision).where("approval.audience", "=", "direct")
    .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", binding.ownerId).where("chat.lifecycle", "=", "active").where("chat.collaboration", "is", null)
    .where("direct.kind", "=", "direct").where("direct.removed_at", "is", null)
    .executeTakeFirst();
  // Evaluate after DB/pool wait too. Later changes still meet existing inference/effect revalidation.
  if (!current?.lease_expires_at || isoTimestamp(current.lease_expires_at) <= now()) throw new BotBrokerActionError("not_granted");
  return { ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, taskId: binding.taskId,
    runId: binding.runId, routineId: routine.routineId, fireId: current.fire_id, approvalId: routine.approvalId! };
}
