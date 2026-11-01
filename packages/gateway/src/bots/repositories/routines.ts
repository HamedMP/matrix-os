import { RoutineAuthorizationSchema, type RoutineAuthorization } from "../routine-authorization.js";
import cron from "node-cron";
import { randomBytes } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { BotRoutineProposalSchema, type BotRoutineProposal, type BotRoutineStatus, type BotRoutineFireStatus } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "../database.js";
import { BotStateError, isoTimestamp, optionalIsoTimestamp, toSafeInteger, withTransaction, type BotExecutor } from "./shared.js";
import { createBotTasksRepository } from "./tasks.js";
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const MAX_ROUTINES = 32;
// Correlated before LIMIT: dead Chats and held occurrences never monopolize a page.
const LIVE_ROUTINE = sql<boolean>`EXISTS (
 SELECT 1 FROM bot_chat_bindings b JOIN chats c ON c.id=b.chat_id
 WHERE b.owner_id=bot_routines.owner_id AND b.bot_id=bot_routines.bot_id AND b.chat_id=bot_routines.chat_id
 AND b.kind='direct' AND b.removed_at IS NULL AND c.owner_type='personal' AND c.owner_id=bot_routines.owner_id
 AND c.collaboration IS NULL AND c.lifecycle='active')`;
const NO_UNFINISHED_FIRE = sql<boolean>`NOT EXISTS (
 SELECT 1 FROM bot_routine_fires f WHERE f.owner_id=bot_routines.owner_id AND f.routine_id=bot_routines.routine_id
 AND f.status IN ('claimed','dispatched','uncertain'))`;
function routine(row: Selectable<OwnerBotDatabase["bot_routines"]>) {
  return {
    routineId: row.routine_id,
    ownerId: row.owner_id,
    botId: row.bot_id,
    chatId: row.chat_id,
    proposal: BotRoutineProposalSchema.parse(typeof row.proposal === "string" ? JSON.parse(row.proposal) : row.proposal),
    authorization: row.approved_source ? RoutineAuthorizationSchema.parse(typeof row.approved_source === "string" ? JSON.parse(row.approved_source) : row.approved_source) : null,
    approvalId: row.approval_id,
    status: row.status,
    nextFireAt: optionalIsoTimestamp(row.next_fire_at),
    revision: toSafeInteger(row.revision),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}
function fire(row: Selectable<OwnerBotDatabase["bot_routine_fires"]>) {
  return {
    fireId: row.fire_id,
    ownerId: row.owner_id,
    routineId: row.routine_id,
    scheduledFor: isoTimestamp(row.scheduled_for),
    taskId: row.task_id,
    status: row.status,
    attempts: row.attempts,
    retryAfter: optionalIsoTimestamp(row.retry_after),
    failureCode: row.failure_code,
    leaseExpiresAt: optionalIsoTimestamp(row.lease_expires_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}
export type BotRoutine = ReturnType<typeof routine>;
export type BotRoutineFire = ReturnType<typeof fire>;
export interface RoutineFinishInput {
  ownerId: string;
  fireId: string;
  status: Exclude<BotRoutineFireStatus, "claimed" | "dispatched">;
  failureCode?: string;
  expectedStatus?: "claimed" | "dispatched";
  leaseExpiredBefore?: string;
  now: string;
}
export function createBotRoutinesRepository(db: BotExecutor) {
  async function get(ownerId: string, routineId: string, ex: BotExecutor = db) {
    const row = await ex.selectFrom("bot_routines").selectAll().where("owner_id", "=", ownerId).where("routine_id", "=", routineId).executeTakeFirst();
    return row ? routine(row) : undefined;
  }
  async function liveBinding(ownerId: string, botId: string, chatId: string, ex: BotExecutor) {
    return ex.selectFrom("bot_chat_bindings as binding").innerJoin("chats as chat", "chat.id", "binding.chat_id").select("binding.chat_id").where("binding.owner_id", "=", ownerId).where("binding.bot_id", "=", botId).where("binding.chat_id", "=", chatId).where("binding.kind", "=", "direct").where("binding.removed_at", "is", null).where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId).where("chat.collaboration", "is", null).where("chat.lifecycle", "=", "active").forUpdate().executeTakeFirst();
  }
  async function finish(input: RoutineFinishInput): Promise<boolean | void> {
    if (input.failureCode && !/^[a-z][a-z0-9_]{0,63}$/.test(input.failureCode)) throw new BotStateError("invalid_input");
    return withTransaction(db, async tx => {
      const existing = await tx.selectFrom("bot_routine_fires").select(["routine_id", "task_id"]).where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).executeTakeFirst();
      if (!existing) return;
      // Preserve routine -> fire -> task lock order, including automatic pause on failure.
      const currentRoutine = await tx.selectFrom("bot_routines").select("status").where("owner_id", "=", input.ownerId).where("routine_id", "=", existing.routine_id).forUpdate().executeTakeFirst();
      if (!currentRoutine) return;
      // Worker success/cancel cannot resolve an unobserved external write/send.
      const unknown = await tx.selectFrom("bot_tool_checkpoints").select("checkpoint_id").where("owner_id", "=", input.ownerId).where("task_id", "=", existing.task_id).where("effect_class", "!=", "read").where("phase", "in", ["dispatched", "effect_unknown"]).limit(1).executeTakeFirst();
      const status = unknown ? "uncertain" : input.status,
        failureCode = unknown ? "effect_outcome_unknown" : input.failureCode;
      let update = tx.updateTable("bot_routine_fires").set({
        status,
        failure_code: failureCode ?? null,
        updated_at: input.now,
        lease_expires_at: null
      }).where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).where("status", "in", input.expectedStatus ? [input.expectedStatus] : ["claimed", "dispatched"]);
      if (input.leaseExpiredBefore) update = update.where("lease_expires_at", "<=", input.leaseExpiredBefore);
      const row = await update.returning("task_id").executeTakeFirst();
      if (!row) return false;
      if (status === "failed" && currentRoutine.status === "active") await tx.updateTable("bot_routines").set({
        status: "paused",
        revision: sql<number>`revision+1`,
        updated_at: input.now
      }).where("owner_id", "=", input.ownerId).where("routine_id", "=", existing.routine_id).where("status", "=", "active").execute();
      const tasks = createBotTasksRepository(tx),
        task = await tasks.get({
          ownerId: input.ownerId,
          taskId: row.task_id
        }, tx);
      if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
        const to = status === "completed" ? task.status === "running" ? "completed" : "failed" : status === "cancelled" ? "cancelled" : "failed";
        await tasks.transition({
          ownerId: input.ownerId,
          taskId: task.taskId,
          baseRevision: task.revision,
          to,
          now: input.now
        }, tx);
      }
      return true;
    });
  }
  const repository = {
    get,
    /** Internal approval handler only. No ordinary create endpoint may call this. */
    async create(input: {
      ownerId: string;
      botId: string;
      chatId: string;
      proposal: BotRoutineProposal;
      authorization?: RoutineAuthorization;
      approvalId?: string;
      nextFireAt: string;
      now: string;
    }, ex: BotExecutor = db) {
      const proposal = BotRoutineProposalSchema.parse(input.proposal);
      if (proposal.schedule.kind === "cron" && !cron.validate(proposal.schedule.expr)) throw new BotStateError("invalid_input");
      if (!Number.isFinite(Date.parse(input.nextFireAt)) || Date.parse(input.nextFireAt) <= Date.parse(input.now)) throw new BotStateError("invalid_input");
      return withTransaction(ex, async tx => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'bot-routines:' + input.ownerId},0))`.execute(tx);
        const binding = await liveBinding(input.ownerId, input.botId, input.chatId, tx);
        if (!binding) throw new BotStateError("not_found");
        const count = await tx.selectFrom("bot_routines").select(eb => eb.fn.countAll<string>().as("n")).where("owner_id", "=", input.ownerId).executeTakeFirstOrThrow();
        if (Number(count.n) >= MAX_ROUTINES) throw new BotStateError("capacity_exceeded");
        const row = await tx.insertInto("bot_routines").values({
          routine_id: id("rt"),
          owner_id: input.ownerId,
          bot_id: input.botId,
          chat_id: input.chatId,
          proposal: JSON.stringify(proposal),
          approved_source: input.authorization ? JSON.stringify(RoutineAuthorizationSchema.parse(input.authorization)) : null,
          approval_id: input.approvalId ?? null,
          status: "active",
          next_fire_at: input.nextFireAt,
          created_at: input.now,
          updated_at: input.now
        }).returningAll().executeTakeFirstOrThrow();
        return routine(row);
      });
    },
    async list(ownerId: string, botId: string, ex: BotExecutor = db) {
      return (await ex.selectFrom("bot_routines").selectAll().where("owner_id", "=", ownerId).where("bot_id", "=", botId).orderBy("created_at").limit(MAX_ROUTINES).execute()).map(routine);
    },
    async due(now: string) {
      return (await db.selectFrom("bot_routines").selectAll().where("status", "=", "active").where("next_fire_at", "<=", now).where(LIVE_ROUTINE).where(NO_UNFINISHED_FIRE).orderBy("next_fire_at").limit(32).execute()).map(routine);
    },
    async control(input: {
      ownerId: string;
      routineId: string;
      baseRevision: number;
      status: BotRoutineStatus;
      now: string;
    }, ex: BotExecutor = db) {
      return withTransaction(ex, async tx => {
        const existing = await tx.selectFrom("bot_routines").selectAll().where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).forUpdate().executeTakeFirst();
        if (!existing) throw new BotStateError("not_found");
        if (toSafeInteger(existing.revision) !== input.baseRevision) throw new BotStateError("revision_conflict");
        if (existing.status === "archived") throw new BotStateError("invalid_transition");
        const row = await tx.updateTable("bot_routines").set({
          status: input.status,
          revision: input.baseRevision + 1,
          updated_at: input.now
        }).where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).returningAll().executeTakeFirstOrThrow();
        return routine(row);
      });
    },
    async claim(input: {
      ownerId: string;
      routineId: string;
      scheduledFor: string;
      nextFireAt: string | null;
      now: string;
    }) {
      if (input.nextFireAt && Date.parse(input.nextFireAt) <= Date.parse(input.now)) throw new BotStateError("invalid_input");
      return withTransaction(db, async tx => {
        const r = await tx.selectFrom("bot_routines").selectAll().where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).forUpdate().executeTakeFirst();
        if (!r || r.status !== "active" || !r.next_fire_at || isoTimestamp(r.next_fire_at) !== input.scheduledFor || Date.parse(input.scheduledFor) > Date.parse(input.now)) return;
        const previous = await tx.selectFrom("bot_routine_fires").select("fire_id").where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).where("scheduled_for", "=", input.scheduledFor).executeTakeFirst();
        if (previous) return;
        const unfinished = await tx.selectFrom("bot_routine_fires").select("fire_id").where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).where("status", "in", ["claimed", "dispatched", "uncertain"]).executeTakeFirst();
        if (unfinished) return;
        // Recheck live binding and serialize the shared Bot Chat before allocating work.
        const binding = await liveBinding(input.ownerId, r.bot_id, r.chat_id, tx);
        if (!binding) return;
        const task = await createBotTasksRepository(tx).create({
          ownerId: input.ownerId,
          botId: r.bot_id,
          chatId: r.chat_id,
          now: input.now
        }, tx);
        const row = await tx.insertInto("bot_routine_fires").values({
          fire_id: id("fire"),
          owner_id: input.ownerId,
          routine_id: input.routineId,
          scheduled_for: input.scheduledFor,
          task_id: task.taskId,
          status: "claimed",
          attempts: 0,
          retry_after: null,
          lease_expires_at: null,
          failure_code: null,
          created_at: input.now,
          updated_at: input.now
        }).returningAll().executeTakeFirstOrThrow();
        await tx.updateTable("bot_routines").set({
          next_fire_at: input.nextFireAt,
          revision: sql<number>`revision+1`,
          updated_at: input.now
        }).where("owner_id", "=", input.ownerId).where("routine_id", "=", input.routineId).execute();
        return fire(row);
      });
    },
    async getFire(ownerId: string, fireId: string) {
      const row = await db.selectFrom("bot_routine_fires").selectAll().where("owner_id", "=", ownerId).where("fire_id", "=", fireId).executeTakeFirst();
      return row ? fire(row) : undefined;
    },
    async forTask(ownerId: string, taskId: string) {
      const row = await db.selectFrom("bot_routine_fires").selectAll().where("owner_id", "=", ownerId).where("task_id", "=", taskId).executeTakeFirst();
      return row ? fire(row) : undefined;
    },
    async fires(ownerId: string, routineId: string) {
      return (await db.selectFrom("bot_routine_fires").selectAll().where("owner_id", "=", ownerId).where("routine_id", "=", routineId).orderBy("scheduled_for", "desc").limit(20).execute()).map(fire);
    },
    async pending(now: string) {
      return (await db.selectFrom("bot_routine_fires").innerJoin("bot_routines", join => join.onRef("bot_routines.routine_id", "=", "bot_routine_fires.routine_id").onRef("bot_routines.owner_id", "=", "bot_routine_fires.owner_id")).selectAll("bot_routine_fires").where("bot_routine_fires.status", "=", "claimed").where("bot_routines.status", "=", "active").where(LIVE_ROUTINE).where(eb => eb.or([eb("retry_after", "is", null), eb("retry_after", "<=", now)])).orderBy("bot_routine_fires.created_at").limit(32).execute()).map(fire);
    },
    async dispatch(input: {
      ownerId: string;
      fireId: string;
      now: string;
    }) {
      return withTransaction(db, async tx => {
        const existing = await tx.selectFrom("bot_routine_fires").selectAll().where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).executeTakeFirst();
        if (!existing) return;
        // Same lock order as control/claim: routine first, then fire. No stale authorization snapshot dispatch.
        const r = await tx.selectFrom("bot_routines").select(["status", "bot_id", "chat_id"]).where("owner_id", "=", input.ownerId).where("routine_id", "=", existing.routine_id).forUpdate().executeTakeFirst();
        if (!r || r.status !== "active" || !(await liveBinding(input.ownerId, r.bot_id, r.chat_id, tx))) return;
        const row = await tx.updateTable("bot_routine_fires").set({
          status: "dispatched",
          attempts: sql<number>`attempts+1`,
          updated_at: input.now,
          retry_after: null,
          lease_expires_at: new Date(Date.parse(input.now) + 12 * 60_000).toISOString()
        }).where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).where("status", "=", "claimed").where("attempts", "<", 3).where(eb => eb.or([eb("retry_after", "is", null), eb("retry_after", "<=", input.now)])).returningAll().executeTakeFirst();
        return row ? fire(row) : undefined;
      });
    },
    finish,
    /** Only a proven pre-dispatch capacity failure can use this path, at most twice. */
    async defer(input: {
      ownerId: string;
      fireId: string;
      retryAfter: string;
      now: string;
    }) {
      return db.updateTable("bot_routine_fires").set({
        status: "claimed",
        retry_after: input.retryAfter,
        lease_expires_at: null,
        updated_at: input.now,
        failure_code: "capacity_unavailable"
      }).where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).where("status", "=", "dispatched").where("attempts", "<", 3).returningAll().executeTakeFirst();
    },
    /** A previous process may have emitted effects. Do not replay it or change other owners' tasks. */
    async recover(input: {
      before: string;
      now: string;
    }, settle: (input: RoutineFinishInput) => Promise<boolean | void> = finish): Promise<number> {
      const invalid = await db.selectFrom("bot_routine_fires").innerJoin("bot_routines", join => join.onRef("bot_routines.routine_id", "=", "bot_routine_fires.routine_id").onRef("bot_routines.owner_id", "=", "bot_routine_fires.owner_id")).select(["bot_routine_fires.fire_id", "bot_routine_fires.owner_id", "bot_routines.status"]).where("bot_routine_fires.status", "=", "claimed").where(eb => eb.or([sql<boolean>`NOT (${LIVE_ROUTINE})`, eb("bot_routines.status", "!=", "active")])).orderBy("bot_routine_fires.created_at").limit(32).execute();
      for (const row of invalid) await settle({
        ownerId: row.owner_id,
        fireId: row.fire_id,
        status: row.status === "active" ? "failed" : "cancelled",
        failureCode: "chat_unavailable",
        expectedStatus: "claimed",
        now: input.now
      });
      const expired = await db.selectFrom("bot_routine_fires").select(["owner_id", "fire_id"]).where("status", "=", "dispatched").where("lease_expires_at", "<=", input.now).orderBy("lease_expires_at").limit(32).execute();
      let changed = 0;
      for (const row of expired) if (await settle({
        ownerId: row.owner_id,
        fireId: row.fire_id,
        status: "uncertain",
        failureCode: "restart_outcome_unknown",
        expectedStatus: "dispatched",
        leaseExpiredBefore: input.now,
        now: input.now
      })) changed++;
      return changed;
    }
  };
  return repository;
}
export type BotRoutinesRepository = ReturnType<typeof createBotRoutinesRepository>;
