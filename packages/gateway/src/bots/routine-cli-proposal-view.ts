import type { RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import { createRoutineCliProposalsRepository } from "./repositories/routine-cli-proposals.js";
import { toSafeInteger, type BotExecutor } from "./repositories/shared.js";
/** Current observed progress is separate from immutable app admission. Never infer activation from run completion. */
export async function routineCliProposalView(ex: BotExecutor, receipt: RoutineCliRequestRecord, now: Date) {
  if (receipt.operation.operation !== "propose") return undefined;
  const dispatch = await createRoutineCliProposalsRepository(ex).get(receipt.target, receipt.requestId, ex);
  if (!dispatch) return undefined; // Older/internal receipt ports have no canonical proposal handoff.
  let handoff = dispatch.stage;
  const task = dispatch.task_id ? await ex.selectFrom("bot_tasks").select(["status"]).where("owner_id", "=", receipt.target.ownerId)
    .where("bot_id", "=", receipt.target.botId).where("chat_id", "=", receipt.target.chatId).where("task_id", "=", dispatch.task_id).executeTakeFirst() : undefined;
  if (dispatch.stage !== "pending_approval") {
    const queue = await ex.selectFrom("chat_queued_turns").select(["status", "request_hash", "claimed_run_id", "claimed_turn_id"]).where("chat_id", "=", receipt.target.chatId).where("client_request_id", "=", dispatch.canonical_request_id).executeTakeFirst();
    const run = await ex.selectFrom("chat_runs").select(["id", "turn_id", "status", "request_hash"]).where("chat_id", "=", receipt.target.chatId).where("client_request_id", "=", dispatch.canonical_request_id).where("attempt", "=", 1).executeTakeFirst();
    const exactRun = run && (run.request_hash === dispatch.request_hash || run.request_hash === null && queue?.request_hash === dispatch.request_hash && queue.claimed_run_id === run.id && queue.claimed_turn_id === run.turn_id);
    if (queue?.status === "cancelled" || task && ["blocked", "failed", "cancelled"].includes(task.status) || exactRun && ["failed", "aborted"].includes(run.status)) handoff = "rejected";
  }
  let approval: "pending" | "approved" | "denied" | "expired" | "cancelled" | null = null;
  let routine: { routineId: string; status: "active" | "paused" | "archived"; revision: number } | null = null;
  if (dispatch.interaction_id) {
    const interaction = await ex.selectFrom("bot_interactions as i").innerJoin("bot_approvals as a", "a.approval_id", "i.interaction_id")
      .select(["i.status", "i.expires_at", "a.status as decision"])
      .where("i.owner_id", "=", receipt.target.ownerId).where("a.owner_id", "=", receipt.target.ownerId)
      .where("i.bot_id", "=", receipt.target.botId).where("a.bot_id", "=", receipt.target.botId).where("i.chat_id", "=", receipt.target.chatId)
      .where("i.interaction_id", "=", dispatch.interaction_id).where("a.tool", "=", "routine.activate").executeTakeFirst();
    if (interaction) approval = interaction.status === "cancelled" ? "cancelled" : interaction.status === "expired"
      || interaction.status === "pending" && new Date(interaction.expires_at).getTime() <= now.getTime() ? "expired"
      : interaction.decision === "approved" ? "approved" : interaction.decision === "denied" ? "denied" : "pending";
    const active = await ex.selectFrom("bot_routines").select(["routine_id", "status", "revision"]).where("owner_id", "=", receipt.target.ownerId)
      .where("bot_id", "=", receipt.target.botId).where("chat_id", "=", receipt.target.chatId).where("approval_id", "=", dispatch.interaction_id).executeTakeFirst();
    if (active) routine = { routineId: active.routine_id, status: active.status, revision: toSafeInteger(active.revision) };
  }
  return { handoff, revision: toSafeInteger(dispatch.revision), approval, routine };
}
