import { sql } from "kysely";
import { BotRoutineCenterQuerySchema, BotRoutineCenterResponseSchema, BotRoutineDetailResponseSchema } from "@matrix-os/contracts";
import type { BotExecutor } from "./repositories/shared.js";
import { BotStateError } from "./repositories/shared.js";
import { createBotRoutinesRepository, type BotRoutine, type BotRoutineFire } from "./repositories/routines.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { projectBotInteraction } from "./interactions.js";
import type { BotRoutineApprovals } from "./routine-approval.js";

/** Owner-scoped projections over the existing tables; does not own the pool. */
export function createBotRoutineManagement(db: BotExecutor, approvals: BotRoutineApprovals) {
  const repository = createBotRoutinesRepository(db);
  const fireView = (fire: BotRoutineFire) => ({ fireId: fire.fireId, taskId: fire.taskId, scheduledFor: fire.scheduledFor,
    status: fire.status, attempts: fire.attempts, failureCode: fire.failureCode, updatedAt: fire.updatedAt });
  async function summary(routine: BotRoutine, history: BotRoutineFire[]) {
    const targetAvailable = await approvals.targetAvailable(routine.ownerId, routine.botId, routine.chatId);
    return { routineId: routine.routineId, botId: routine.botId, chatId: routine.chatId, proposal: routine.proposal,
      computerId: routine.authorization?.computerId ?? null, status: routine.status, revision: routine.revision,
      nextFireAt: routine.nextFireAt, requiresReview: history.some(f => f.status === "uncertain"), targetAvailable,
      sourceAvailable: targetAvailable && routine.status !== "archived" && await approvals.authorize({ ...routine, status: "active" }),
      lastFire: history[0] ? fireView(history[0]) : null };
  }
  return {
    async center(ownerId: string, raw: unknown = {}) {
      const input = BotRoutineCenterQuerySchema.parse(raw), rows = await repository.listOwner(ownerId, input), page = rows.slice(0, 32);
      const items = await Promise.all(page.map(async row => summary(row, await repository.fires(ownerId, row.routineId))));
      const ids = await db.selectFrom("bot_interactions as interaction")
        .innerJoin("chats as chat", "chat.id", "interaction.chat_id")
        .innerJoin("bot_chat_bindings as binding", join => join.onRef("binding.owner_id", "=", "interaction.owner_id")
          .onRef("binding.bot_id", "=", "interaction.bot_id").onRef("binding.chat_id", "=", "interaction.chat_id"))
        .select("interaction.interaction_id").where("interaction.owner_id", "=", ownerId).where("interaction.responder_actor_id", "=", ownerId)
        .where("interaction.kind", "=", "approval").where("interaction.status", "=", "pending")
        .where(sql<boolean>`interaction.payload->>'tool' = 'routine.activate'`)
        .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId).where("chat.collaboration", "is", null)
        .where("chat.lifecycle", "=", "active").where("binding.kind", "=", "direct").where("binding.removed_at", "is", null)
        .orderBy("interaction.created_at", "desc").limit(32).execute();
      const pending = [];
      const interactions = createBotInteractionsRepository(db);
      for (const id of ids) {
        const record = await interactions.get({ ownerId, interactionId: id.interaction_id });
        if (record?.status === "pending") pending.push(projectBotInteraction(record, ownerId));
      }
      const last = page.at(-1);
      return BotRoutineCenterResponseSchema.parse({ items, pending, nextCursor: rows.length > 32 && last
        ? { before: last.createdAt, beforeId: last.routineId } : null });
    },
    async detail(ownerId: string, routineId: string) {
      const routine = await repository.get(ownerId, routineId);
      if (!routine) throw new BotStateError("not_found");
      const history = await repository.fires(ownerId, routineId);
      return BotRoutineDetailResponseSchema.parse({ routine: await summary(routine, history), history: history.map(fireView) });
    },
  };
}
