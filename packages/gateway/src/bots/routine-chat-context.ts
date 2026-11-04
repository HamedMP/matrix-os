import { sql } from "kysely";
import type { BotExecutor } from "./repositories/shared.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { hasLiveRoutineChat } from "./routine-authorization.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import { readResolvedRoutineApproval } from "./routine-approval-receipt.js";

const explanation = "\n\nCurrent Chat schedule state (read by Matrix from owner records):\n";
const limitation = "\nThis describes stored state and does not authorize execution. Historical pending-approval messages are not current state. Do not claim a task still awaits approval unless pending is nonzero. resolvedApproval describes only the owner decision matched to this continuation; never call that approval pending. Active does not mean running now. Use Schedules for exact task details. Current broker permissions remain authoritative.";
// At most 32 non-archived owner routines and 32 projected pending approvals.
export const ROUTINE_CHAT_CONTEXT_RESERVATION = explanation + JSON.stringify({ active: 32, paused: 32, needsReview: 32, pending: 32, resolvedApproval: "approved" }) + limitation;

/** No model/user field is accepted. Called again at spec delivery, after admission. */
export async function describeRoutineChatPhase(db: BotExecutor, approvals: BotRoutineApprovals, binding: BotRuntimeBinding, now: string): Promise<string | null> {
  if (binding.group || binding.requestClass !== "interactive") return null;
  const task = await db.selectFrom("bot_tasks").select("task_id").where("owner_id", "=", binding.ownerId)
    .where("bot_id", "=", binding.botId).where("chat_id", "=", binding.chatId).where("task_id", "=", binding.taskId)
    .where("run_id", "=", binding.runId).where("status", "=", "running").executeTakeFirst();
  if (!task || !(await hasLiveRoutineChat(db, binding.ownerId, binding.botId, binding.chatId))) return null;
  const rows = (await createBotRoutinesRepository(db).list(binding.ownerId, binding.botId)).filter(row => row.chatId === binding.chatId);
  const pending = await db.selectFrom("bot_interactions").select("interaction_id")
    .where("owner_id", "=", binding.ownerId).where("bot_id", "=", binding.botId).where("chat_id", "=", binding.chatId)
    .where("responder_actor_id", "=", binding.ownerId).where("status", "=", "pending").where("expires_at", ">", now)
    .where(sql<boolean>`payload->>'tool' = 'routine.activate'`).limit(32).execute();
  const resolved = await readResolvedRoutineApproval(db, binding, now);
  if (!rows.length && !pending.length && !resolved) return null;
  const counts = { active: 0, paused: 0, needsReview: 0, pending: pending.length,
    resolvedApproval: resolved?.status === "approved" ? "approved" : resolved?.status === "denied" ? "denied" : null };
  for (const row of rows) {
    if (row.status === "archived") continue;
    if (!await approvals.authorize({ ...row, status: "active" })) counts.needsReview += 1;
    else if (row.status === "paused") counts.paused += 1;
    else counts.active += 1;
  }
  return explanation + JSON.stringify(counts) + limitation;
}
