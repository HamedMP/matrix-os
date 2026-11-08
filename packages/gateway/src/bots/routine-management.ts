import { acceptedRoutineOriginTarget } from "./routine-chat-origin-target.js";
import { isMappedDirectRoutineSourceAvailable, isDirectRoutineTarget, isDirectRoutineTargetSql } from "./routine-direct-chat-lifecycle.js";
import { RoutineCliSourceContextSchema } from "./routine-cli-source-context.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import { parseJson } from "../chat/records.js";
import { sql } from "kysely";
import { BotRoutineCenterQuerySchema, BotRoutineCenterResponseSchema, BotRoutineDetailResponseSchema } from "@matrix-os/contracts";
import type { BotExecutor } from "./repositories/shared.js";
import { BotStateError } from "./repositories/shared.js";
import { createBotRoutinesRepository, type BotRoutine, type BotRoutineFire } from "./repositories/routines.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { projectBotInteraction } from "./interactions.js";
import type { BotRoutineApprovals } from "./routine-approval.js";

/** Owner-scoped projections over the existing tables; does not own the pool. */
export function createBotRoutineManagement(db: BotExecutor, approvals: BotRoutineApprovals, now = () => new Date().toISOString()) {
  const repository = createBotRoutinesRepository(db);
  const fireView = (fire: BotRoutineFire) => ({ fireId: fire.fireId, taskId: fire.taskId, scheduledFor: fire.scheduledFor,
    status: fire.status, attempts: fire.attempts, failureCode: fire.failureCode, updatedAt: fire.updatedAt });
  async function summary(routine: BotRoutine, history: BotRoutineFire[], includeOrigin: boolean) {
    const backingAvailable = await approvals.targetAvailable(routine.ownerId, routine.botId, routine.chatId);
    const direct = isDirectRoutineTarget(routine);
    let origin: { originChatId?: string; originAvailable: boolean } | undefined = direct ? { originAvailable: false } : undefined;
    if (routine.origin && (direct || includeOrigin)) {
      const ledger = await db.selectFrom("routine_cli_requests").select(["source_context", "target_snapshot"]).where("owner_id", "=", routine.ownerId)
        .where("computer_id", "=", routine.origin.computerId).where("client_request_id", "=", routine.origin.requestId).executeTakeFirst();
      const source = RoutineCliSourceContextSchema.safeParse(ledger && parseJson(ledger.source_context));
      if (source.success && source.data.identity.kind === "chat_run" && source.data.ownerId === routine.ownerId && source.data.computerId === routine.origin.computerId) {
        const sourceChatId = source.data.identity.chatId;
        const target = direct ? acceptedRoutineOriginTarget(ledger?.target_snapshot, routine.ownerId,
          routine.origin.computerId, routine.botId, routine.chatId, sourceChatId) : undefined;
        if (direct) {
          if (target && "purpose" in target) {
            origin = { originChatId: sourceChatId, originAvailable: await isMappedDirectRoutineSourceAvailable(db, target) };
          }
        } else {
          const chat = await db.selectFrom("chats").select("id").where("id", "=", sourceChatId).where("owner_type", "=", "personal")
            .where("owner_id", "=", routine.ownerId).where("lifecycle", "=", "active").where("collaboration", "is", null).executeTakeFirst();
          origin = { originChatId: sourceChatId, originAvailable: Boolean(chat) && !await hasNonPrivateChatScope(db as never, { type: "personal", ownerId: routine.ownerId }, sourceChatId) };
        }
      }
    }
    // Preserve the existing wire shape for older clients. Never offer an internal target
    // fallback when the original Chat is gone or cannot be independently verified.
    const targetAvailable = backingAvailable && (!direct || origin?.originAvailable === true);
    return { ...(includeOrigin ? origin : undefined), routineId: routine.routineId, botId: routine.botId,
      chatId: direct ? origin?.originChatId ?? routine.chatId : routine.chatId, proposal: routine.proposal,
      computerId: routine.authorization?.computerId ?? null, status: routine.status, revision: routine.revision,
      nextFireAt: routine.nextFireAt, requiresReview: history.some(f => f.status === "uncertain"), targetAvailable,
      sourceAvailable: targetAvailable && routine.status !== "archived" && await approvals.authorize({ ...routine, status: "active" }),
      lastFire: history[0] ? fireView(history[0]) : null };
  }
  return {
    async center(ownerId: string, raw: unknown = {}, includeOrigin = false) {
      const input = BotRoutineCenterQuerySchema.parse(raw), rows = await repository.listOwner(ownerId, input), page = rows.slice(0, 32);
      const items = await Promise.all(page.map(async row => summary(row, await repository.fires(ownerId, row.routineId), includeOrigin)));
      const ids = await db.selectFrom("bot_interactions as interaction")
        .innerJoin("chats as chat", "chat.id", "interaction.chat_id")
        .innerJoin("bot_chat_bindings as binding", join => join.onRef("binding.owner_id", "=", "interaction.owner_id")
          .onRef("binding.bot_id", "=", "interaction.bot_id").onRef("binding.chat_id", "=", "interaction.chat_id"))
        .select("interaction.interaction_id").where("interaction.owner_id", "=", ownerId).where("interaction.responder_actor_id", "=", ownerId)
        .where("interaction.kind", "=", "approval").where("interaction.status", "=", "pending")
        .where("interaction.expires_at", ">", now())
        .where(sql<boolean>`interaction.payload->>'tool' = 'routine.activate'`)
        .where(sql<boolean>`NOT ${isDirectRoutineTargetSql({ botId: sql.ref("interaction.bot_id"), chatId: sql.ref("interaction.chat_id") })}`)
        .where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId).where("chat.collaboration", "is", null)
        .where("chat.lifecycle", "=", "active").where("binding.kind", "=", "direct").where("binding.removed_at", "is", null)
        .orderBy("interaction.created_at", "desc").limit(32).execute();
      const pending = [];
      const interactions = createBotInteractionsRepository(db);
      for (const id of ids) {
        const record = await interactions.get({ ownerId, interactionId: id.interaction_id });
        if (record?.status === "pending" && Date.parse(record.expiresAt) > Date.parse(now())) pending.push(projectBotInteraction(record, ownerId));
      }
      const last = page.at(-1);
      return BotRoutineCenterResponseSchema.parse({ items, pending, nextCursor: rows.length > 32 && last
        ? { before: last.createdAt, beforeId: last.routineId } : null });
    },
    async detail(ownerId: string, routineId: string, includeOrigin = false) {
      const routine = await repository.get(ownerId, routineId);
      if (!routine) throw new BotStateError("not_found");
      const history = await repository.fires(ownerId, routineId);
      return BotRoutineDetailResponseSchema.parse({ routine: await summary(routine, history, includeOrigin), history: history.map(fireView) });
    },
  };
}
