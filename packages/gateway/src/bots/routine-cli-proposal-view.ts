import type { RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import { createRoutineCliProposalsRepository } from "./repositories/routine-cli-proposals.js";
import { toSafeInteger, type BotExecutor } from "./repositories/shared.js";
/** Current observed progress is separate from immutable app admission. Never infer activation from run completion. */
export async function routineCliProposalView(ex: BotExecutor, receipt: RoutineCliRequestRecord, now: Date) {
  if (receipt.operation.operation !== "propose") return undefined;
  const dispatch = await createRoutineCliProposalsRepository(ex).get(receipt.target, receipt.requestId, ex);
  if (!dispatch) {
    if (receipt.source.identity.kind !== "bot_child" || receipt.admission.disposition !== "pending_approval") return undefined;
    const observation = await observeRoutineApproval(ex, receipt, receipt.admission.interactionId, now);
    return { handoff: "pending_approval" as const, existingBinding: true as const, ...observation };
  }
  let handoff = dispatch.stage;
  const task = dispatch.task_id ? await ex.selectFrom("bot_tasks").select(["status"]).where("owner_id", "=", receipt.target.ownerId)
    .where("bot_id", "=", receipt.target.botId).where("chat_id", "=", receipt.target.chatId).where("task_id", "=", dispatch.task_id).executeTakeFirst() : undefined;
  if (dispatch.stage !== "pending_approval") {
    const queue = await ex.selectFrom("chat_queued_turns").select(["status", "request_hash", "claimed_run_id", "claimed_turn_id"]).where("chat_id", "=", receipt.target.chatId).where("client_request_id", "=", dispatch.canonical_request_id).executeTakeFirst();
    const run = await ex.selectFrom("chat_runs").select(["id", "turn_id", "status", "request_hash"]).where("chat_id", "=", receipt.target.chatId).where("client_request_id", "=", dispatch.canonical_request_id).where("attempt", "=", 1).executeTakeFirst();
    const exactRun = run && (run.request_hash === dispatch.request_hash || run.request_hash === null && queue?.request_hash === dispatch.request_hash && queue.claimed_run_id === run.id && queue.claimed_turn_id === run.turn_id);
    if (queue?.status === "cancelled" || task && ["blocked", "failed", "cancelled"].includes(task.status) || exactRun && ["failed", "aborted"].includes(run.status)) handoff = "rejected";
  }
  const observation = await observeRoutineApproval(ex, receipt, dispatch.interaction_id, now);
  return { handoff, revision: toSafeInteger(dispatch.revision), ...observation };
}
async function observeRoutineApproval(ex: BotExecutor, receipt: RoutineCliRequestRecord, interactionId: string | null, now: Date) {
  let approval: "pending" | "approved" | "denied" | "expired" | "cancelled" | null = null;
  let routine: { routineId: string; status: "active" | "paused" | "archived"; revision: number } | null = null;
  if (interactionId) {
    const interaction = await ex.selectFrom("bot_interactions as i").innerJoin("bot_approvals as a", "a.approval_id", "i.interaction_id")
      .select(["i.status", "i.expires_at", "a.status as decision"])
      .where("i.owner_id", "=", receipt.target.ownerId).where("a.owner_id", "=", receipt.target.ownerId)
      .where("i.bot_id", "=", receipt.target.botId).where("a.bot_id", "=", receipt.target.botId).where("i.chat_id", "=", receipt.target.chatId)
      .where("i.interaction_id", "=", interactionId).where("i.responder_actor_id", "=", receipt.target.ownerId).where("a.tool", "=", "routine.activate").executeTakeFirst();
    if (interaction) approval = interaction.status === "cancelled" ? "cancelled" : interaction.status === "expired"
      || interaction.status === "pending" && new Date(interaction.expires_at).getTime() <= now.getTime() ? "expired"
      : interaction.decision === "approved" ? "approved" : interaction.decision === "denied" ? "denied" : "pending";
    const active = await ex.selectFrom("bot_routines").select(["routine_id", "status", "revision"]).where("owner_id", "=", receipt.target.ownerId)
      .where("bot_id", "=", receipt.target.botId).where("chat_id", "=", receipt.target.chatId).where("approval_id", "=", interactionId).executeTakeFirst();
    if (active) routine = { routineId: active.routine_id, status: active.status, revision: toSafeInteger(active.revision) };
  }
  // Content edits replace the standing approval reference. This receipt retains its original
  // approval history; absence of a current direct link proves nothing about routine lifecycle.
  return { approval, routine, ...(approval === "approved" && !routine ? { routineLink: "unavailable" as const } : {}) };
}
