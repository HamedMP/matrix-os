import { sql } from "kysely";
import type { BotExecutor } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

type Scope = Pick<BotRuntimeBinding, "ownerId" | "botId" | "chatId" | "taskId" | "runId">;

/** Persisted decision for this admitted continuation, never activation prose from a person/model. */
export async function readResolvedRoutineApproval(db: BotExecutor, scope: Scope, now: string) {
  return db.selectFrom("chat_runs as run")
    .innerJoin("bot_interactions as interaction", join => join.onRef("interaction.chat_id", "=", "run.chat_id")
      .on(sql<boolean>`run.client_request_id = 'req_answer_' || interaction.interaction_id`))
    .innerJoin("bot_approvals as approval", join => join.onRef("approval.owner_id", "=", "interaction.owner_id")
      .onRef("approval.bot_id", "=", "interaction.bot_id").onRef("approval.approval_id", "=", "interaction.interaction_id")
      .onRef("approval.task_id", "=", "interaction.task_id"))
    .innerJoin("bot_tasks as task", join => join.onRef("task.owner_id", "=", "interaction.owner_id")
      .onRef("task.task_id", "=", "interaction.task_id").onRef("task.bot_id", "=", "interaction.bot_id")
      .onRef("task.chat_id", "=", "interaction.chat_id").onRef("task.run_id", "=", "run.id"))
    .innerJoin("chats as chat", "chat.id", "run.chat_id")
    .innerJoin("bot_chat_bindings as binding", join => join.onRef("binding.owner_id", "=", "interaction.owner_id")
      .onRef("binding.bot_id", "=", "interaction.bot_id").onRef("binding.chat_id", "=", "interaction.chat_id"))
    .select("approval.status").where("run.id", "=", scope.runId).where("run.chat_id", "=", scope.chatId)
    .where("run.driver_kind", "=", "matrix_bot").where("run.status", "in", ["accepted", "running"])
    .where("interaction.owner_id", "=", scope.ownerId).where("interaction.bot_id", "=", scope.botId)
    .where("interaction.task_id", "=", scope.taskId).where("interaction.responder_actor_id", "=", scope.ownerId)
    .where("interaction.status", "=", "resolved").where("interaction.kind", "=", "approval")
    .where("interaction.expires_at", ">", now).where("task.status", "=", "running")
    .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", scope.ownerId)
    .where("chat.lifecycle", "=", "active").where("chat.collaboration", "is", null)
    .where("binding.kind", "=", "direct").where("binding.removed_at", "is", null)
    .where("approval.tool", "=", "routine.activate").where("approval.audience", "=", "direct")
    .where(sql<boolean>`interaction.payload->>'tool' = 'routine.activate' AND
      interaction.payload->>'argsDigest' = approval.args_hash AND
      ((approval.status = 'approved' AND approval.claimed_at IS NOT NULL AND interaction.resolution->>'decision' = 'approve')
       OR (approval.status = 'denied' AND interaction.resolution->>'decision' = 'deny'))`).executeTakeFirst();
}

/** Only acknowledges a decision; current lifecycle/source checks remain at execution. */
export async function routineApprovalReply(db: BotExecutor, scope: Scope, now: string): Promise<string | null> {
  const receipt = await readResolvedRoutineApproval(db, scope, now);
  return receipt?.status === "approved"
    ? "Your schedule approval was recorded. Open Schedules to see its current status and next run."
    : receipt?.status === "denied" ? "Your schedule request was declined. Existing schedules are unchanged." : null;
}
