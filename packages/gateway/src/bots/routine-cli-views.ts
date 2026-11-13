import { routineCliProposalView } from "./routine-cli-proposal-view.js";
import { RoutineCliRoutineViewSchema, RoutineCliReceiptSchema, type RoutineCliRoutineView, type RoutineCliResult } from "@matrix-os/contracts";
import { createBotRoutinesRepository, type BotRoutine } from "./repositories/routines.js";
import type { BotExecutor } from "./repositories/shared.js";
import type { RoutineCliResolvedTarget } from "./routine-cli-targets.js";
import type { RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import { RoutineCliError } from "./routine-cli-errors.js";
const observed = (fire: { status: string; scheduledFor: string; updatedAt: string }) => ({ status: fire.status, scheduledFor: fire.scheduledFor, updatedAt: fire.updatedAt });
/** Caller must hold validated source and exact target/action gates in the same transaction. */
export function createRoutineCliViews(executor: BotExecutor, now: () => Date = () => new Date()) {
  const routines = createBotRoutinesRepository(executor);
  const view = async (record: BotRoutine, page?: Awaited<ReturnType<typeof routines.fireHistory>>): Promise<RoutineCliRoutineView> => {
    const history = page ?? await routines.fireHistory(record.ownerId, record.routineId, executor);
    return RoutineCliRoutineViewSchema.parse({ routineId: record.routineId, name: record.proposal.name, schedule: record.proposal.schedule,
      status: record.status, nextFireAt: record.nextFireAt, revision: record.revision, requiresReview: history.requiresReview,
      lastFire: history.fires[0] ? observed(history.fires[0]) : null });
  };
  const show = async (target: RoutineCliResolvedTarget, routineId: string) => {
    const record = await routines.getForChat({ ...target, routineId }, executor);
    if (!record) throw new RoutineCliError("not_found");
    const history = await routines.fireHistory(target.ownerId, routineId, executor);
    return { kind: "show" as const, routine: await view(record, history), history: { fires: history.fires.map(observed), truncated: history.truncated } };
  };
  return {
    async list(target: RoutineCliResolvedTarget) {
      const page = await routines.listForChat(target, executor);
      const views: RoutineCliRoutineView[] = [];
      for (const record of page.routines) views.push(await view(record));
      return { kind: "list" as const, routines: views, truncated: page.truncated };
    },
    show,
    /** Observation in the owning DB transaction; later post-commit stop work may change fire state.
     * Fresh show/request authorization is required to observe those subsequent changes. */
    async receipt(record: RoutineCliRequestRecord): Promise<Extract<RoutineCliResult, { kind: "receipt" }>> {
      const { interactionId: _hidden, ...safeAdmission } = record.admission as typeof record.admission & { interactionId?: string };
      const receipt = RoutineCliReceiptSchema.parse({ requestId: record.requestId, operation: record.operation.operation,
        revision: record.revision, createdAt: record.createdAt, ...safeAdmission,
        ...(record.admission.disposition === "unknown" ? { reconcile: true } : {}) });
      let current: RoutineCliRoutineView | null = null;
      if (record.operation.operation !== "propose") current = (await show(record.target, record.operation.routineId)).routine;
      let approval: "pending" | "resolved" | "expired" | "cancelled" | null = null;
      if (record.admission.disposition === "pending_approval") {
        const interaction = await executor.selectFrom("bot_interactions").select(["status", "expires_at"]).where("interaction_id", "=", record.admission.interactionId)
          .where("owner_id", "=", record.target.ownerId).where("bot_id", "=", record.target.botId).where("chat_id", "=", record.target.chatId).executeTakeFirst();
        approval = interaction?.status === "pending" && new Date(interaction.expires_at).getTime() <= now().getTime()
          ? "expired" : interaction?.status ?? null;
      }
      const proposal = await routineCliProposalView(executor, record, now());
      return { kind: "receipt", receipt, current, approval, ...(proposal ? { proposal } : {}),
        ...(receipt.disposition === "applied" && (receipt.operation === "pause" || receipt.operation === "archive")
          ? { execution: { stop: "unconfirmed" as const } } : {}) };
    },
  };
}
