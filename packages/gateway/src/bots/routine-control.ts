import { BotRoutineControlSchema } from "@matrix-os/contracts";
import type { BotStateTransaction } from "./events.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import { createBotRoutinesRepository, type BotRoutine, type BotRoutineFire } from "./repositories/routines.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";

export type BotRoutineControlCommit = Pick<BotRoutine, "ownerId" | "botId" | "chatId" | "routineId" | "status" | "revision">;
/** The same canonical control is used by owner/native and source CLI callers. Authorization/data/outbox
 * stay in the caller's transaction; worker cancellation belongs exclusively after confirmed commit. */
export function createBotRoutineControl(deps: {
  db: BotExecutor; approvals: Pick<BotRoutineApprovals, "authorize">; now: () => string;
  stopFire: (ownerId: string, chatId: string, fire: BotRoutineFire) => Promise<void>;
}) {
  return {
    async controlWithin(tx: BotStateTransaction, ownerId: string, botId: string, routineId: string, raw: unknown, chatId?: string) {
      if (!tx.db.isTransaction) throw new BotStateError("invalid_input");
      const input = BotRoutineControlSchema.parse(raw), repository = createBotRoutinesRepository(tx.db);
      const existing = await repository.lock(ownerId, routineId, tx.db);
      if (!existing || existing.botId !== botId || chatId !== undefined && existing.chatId !== chatId) throw new BotStateError("not_found");
      if (existing.revision !== input.baseRevision) throw new BotStateError("revision_conflict");
      if (existing.status === "archived") throw new BotStateError("invalid_transition");
      if (input.status === "active") {
        if (await repository.hasUncertain(ownerId, routineId, tx.db)) throw new BotStateError("conflict");
        if (!await deps.approvals.authorize({ ...existing, status: "active" }, tx.db)) throw new BotStateError("invalid_input");
      }
      const routine = await repository.control({ ownerId, routineId, ...input, now: deps.now() }, tx.db);
      await tx.publish(routine.chatId, "bot.authority.changed", { agentId: botId, revision: routine.revision });
      return routine;
    },
    /** No transaction/capability is retained. ACK is never proof of worker exit or external effects. */
    async afterControlCommit(routine: BotRoutineControlCommit) {
      if (routine.status === "active") return;
      const repository = createBotRoutinesRepository(deps.db);
      let cursor: string | undefined;
      for (;;) {
        const page = await repository.activeFires(routine.ownerId, routine.routineId, routine, cursor);
        for (const fire of page) await deps.stopFire(routine.ownerId, routine.chatId, fire);
        if (page.length < 32) return;
        cursor = page[page.length - 1]!.fireId;
      }
    },
  };
}
export type BotRoutineControl = ReturnType<typeof createBotRoutineControl>;
