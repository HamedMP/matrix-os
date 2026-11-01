import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import type { BotToolRequest, CanonicalOwnerScope } from "@matrix-os/contracts";
import { BotRoutineControlSchema } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import { routineSelection } from "./routine-authorization.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { createBotTasksRepository } from "./repositories/tasks.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import type { BotTurnResult } from "./task-orchestrator.js";
import { effectOf } from "./integration-tools.js";
import { createBotRoutineCanonicalRunner, botRoutineRequestId } from "./continuations.js";
import { createBotRoutineScheduler } from "./routine-scheduler.js";
import { assertCurrentRoutinePhase } from "./routine-phase.js";
import { createBotRoutineManagement } from "./routine-management.js";
import { describeRoutineChatPhase } from "./routine-chat-context.js";
import { routineApprovalReply } from "./routine-approval-receipt.js";
import { createBotStateTransactions, type BotStateTransactions } from "./events.js";
import { ChatRepository } from "../chat/repository.js";
import type { ChatDatabase } from "../chat/database.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
type RunIdentity = {
  owner: CanonicalOwnerScope;
  chatId: string;
  runId: string;
};
type Canonical = {
  repository: Pick<ChatRepository, "get" | "findQueuedAdmission" | "cancelQueuedTurn">;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn" | "enqueueQueuedTurn" | "cancelRun">;
};
/** One canonical Bot executor, one durable fire. No new credential, runtime or notification loop. */
export function createBotRoutineExecution(deps: {
  db: Kysely<OwnerBotDatabase>;
  approvals: BotRoutineApprovals;
  transact?: BotStateTransactions;
  available?: () => boolean;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const repository = createBotRoutinesRepository(deps.db, { now }),
    tasks = createBotTasksRepository(deps.db);
  const transact = deps.transact ?? createBotStateTransactions(new ChatRepository(deps.db as unknown as Kysely<ChatDatabase>));
  const readRun = (input: RunIdentity) => deps.db.selectFrom("chat_runs as run")
    .innerJoin("chat_turns as turn", join => join.onRef("turn.id", "=", "run.turn_id").onRef("turn.chat_id", "=", "run.chat_id"))
    .select(["run.client_request_id", "run.driver_kind", "run.attempt", "turn.client_request_id as original_request_id"])
    .where("run.id", "=", input.runId).where("run.chat_id", "=", input.chatId).executeTakeFirst();
  let canonical: Canonical | undefined, scheduler: ReturnType<typeof createBotRoutineScheduler> | undefined;
  async function finish(input: Parameters<typeof repository.finish>[0], unstarted?: { chatId: string; attempt: number } & ({ kind: "canonical_run"; runId: string } | { kind: "cancelled_queue"; queuedTurnId: string })) {
    return transact(input.ownerId, async tx => {
      const scoped = createBotRoutinesRepository(tx.db);
      if (unstarted) {
        const selected = await scoped.getFire(input.ownerId, input.fireId);
        if (!selected) return false;
        // Match the repository's routine -> fire -> task lock order. A stale adapter
        // cannot finish a newer attempt, a foreign Chat, or a task that began running.
        const routine = await tx.db.selectFrom("bot_routines").select(["chat_id", "bot_id"]).where("owner_id", "=", input.ownerId).where("routine_id", "=", selected.routineId).forUpdate().executeTakeFirst();
        const fire = await tx.db.selectFrom("bot_routine_fires").selectAll().where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).forUpdate().executeTakeFirst();
        if (!routine || routine.chat_id !== unstarted.chatId || !fire || fire.status !== "dispatched" || fire.attempts !== unstarted.attempt) return false;
        const task = await tx.db.selectFrom("bot_tasks").selectAll().where("owner_id", "=", input.ownerId).where("task_id", "=", fire.task_id).forUpdate().executeTakeFirst();
        if (!task || task.chat_id !== unstarted.chatId || task.bot_id !== routine.bot_id
          || !(task.status === "queued" && !task.run_id && unstarted.attempt === 1
            || task.status === "blocked" && task.blocked_reason === "capacity_unavailable" && fire.failure_code === "capacity_unavailable" && unstarted.attempt > 1)
          ) return false;
        const requestId = botRoutineRequestId({ fireId: fire.fire_id, attempts: fire.attempts });
        if (unstarted.kind === "canonical_run") {
          const run = await tx.db.selectFrom("chat_runs").select(["client_request_id", "driver_kind", "attempt"]).where("id", "=", unstarted.runId).where("chat_id", "=", unstarted.chatId).executeTakeFirst();
          if (!run || run.driver_kind !== "matrix_bot" || run.attempt !== 1 || run.client_request_id !== requestId) return false;
        } else {
          const queued = await tx.db.selectFrom("chat_queued_turns").select(["status", "client_request_id", "claimed_run_id", "driver_kind"]).where("id", "=", unstarted.queuedTurnId).where("chat_id", "=", unstarted.chatId).forUpdate().executeTakeFirst();
          if (!queued || queued.status !== "cancelled" || queued.claimed_run_id || queued.driver_kind !== "matrix_bot" || queued.client_request_id !== requestId) return false;
        }
      }
      if (!(await scoped.finish(input))) return false;
      const fire = await scoped.getFire(input.ownerId, input.fireId);
      if (!fire) return false;
      const routine = await scoped.get(input.ownerId, fire.routineId);
      if (!routine) return;
      const interactions = createBotInteractionsRepository(tx.db);
      for (const pending of await interactions.listPending({ ownerId: input.ownerId, chatId: routine.chatId, now: input.now }, tx.db)) {
        if (pending.taskId !== fire.taskId || !await interactions.cancel({ ownerId: input.ownerId, interactionId: pending.interactionId, now: input.now }, tx.db)) continue;
        const cancelled = await interactions.get({ ownerId: input.ownerId, interactionId: pending.interactionId }, tx.db);
        if (cancelled) await tx.publish(routine.chatId, "interaction.resolved", { interactionId: cancelled.interactionId, chatId: routine.chatId, status: cancelled.status, revision: cancelled.revision });
      }
      await tx.publish(routine.chatId, "bot.authority.changed", {
        agentId: routine.botId,
        revision: routine.revision
      });
      const task = await createBotTasksRepository(tx.db).get({
        ownerId: input.ownerId,
        taskId: fire.taskId
      }, tx.db);
      if (task) await tx.publish(routine.chatId, "bot.task.updated", {
        taskId: task.taskId,
        chatId: task.chatId,
        agentId: task.botId,
        status: task.status,
        revision: task.revision
      });
      return true;
    });
  }
  async function reconcileCancelledQueue() {
    const cancelled = await deps.db.selectFrom("bot_routine_fires as f")
      .innerJoin("bot_routines as r", join => join.onRef("r.owner_id", "=", "f.owner_id").onRef("r.routine_id", "=", "f.routine_id"))
      .innerJoin("bot_tasks as t", join => join.onRef("t.owner_id", "=", "f.owner_id").onRef("t.task_id", "=", "f.task_id"))
      .innerJoin("chat_queued_turns as q", join => join.onRef("q.chat_id", "=", "r.chat_id").on("q.client_request_id", "=", sql<string>`'req_routine_' || f.fire_id || CASE WHEN f.attempts > 1 THEN '_a' || f.attempts::text ELSE '' END`))
      .select(["f.owner_id", "f.fire_id", "f.attempts", "r.chat_id", "q.id"])
      .where("f.status", "=", "dispatched").where("q.status", "=", "cancelled").where("q.claimed_run_id", "is", null).where("q.driver_kind", "=", "matrix_bot")
      .where(sql<boolean>`((t.status='queued' AND t.run_id IS NULL AND f.attempts=1) OR (t.status='blocked' AND t.blocked_reason='capacity_unavailable' AND f.failure_code='capacity_unavailable' AND f.attempts>1))`)
      .orderBy("q.cancelled_at").limit(32).execute();
    for (const row of cancelled) await finish({ ownerId: row.owner_id, fireId: row.fire_id, status: "cancelled", expectedStatus: "dispatched", now: now() },
      { kind: "cancelled_queue", chatId: row.chat_id, queuedTurnId: row.id, attempt: row.attempts });
  }
  async function renewUnstartedLease(input: { ownerId: string; fireId: string; now: string; leaseExpiredBefore?: string }, admission?: { chatId: string; runId: string; attempt: number; routineRevision: number }): Promise<boolean> {
    const expiredBefore = input.leaseExpiredBefore;
    if (!expiredBefore && !admission) return false;
    return transact(input.ownerId, async tx => {
      const selected = await createBotRoutinesRepository(tx.db).getFire(input.ownerId, input.fireId);
      if (!selected) return false;
      const routine = await tx.db.selectFrom("bot_routines").select(["status", "chat_id", "bot_id", "revision"])
        .where("owner_id", "=", input.ownerId).where("routine_id", "=", selected.routineId).forUpdate().executeTakeFirst();
      const fire = await tx.db.selectFrom("bot_routine_fires").selectAll()
        .where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId).forUpdate().executeTakeFirst();
      if (!routine || routine.status !== "active" || !fire || fire.status !== "dispatched" || !fire.lease_expires_at) return false;
      if (admission && (routine.chat_id !== admission.chatId || Number(routine.revision) !== admission.routineRevision || fire.attempts !== admission.attempt)) return false;
      const task = await tx.db.selectFrom("bot_tasks").selectAll().where("owner_id", "=", input.ownerId)
        .where("task_id", "=", fire.task_id).forUpdate().executeTakeFirst();
      if (!task || task.chat_id !== routine.chat_id || task.bot_id !== routine.bot_id
        || !(task.status === "queued" && !task.run_id && fire.attempts === 1
          || task.status === "blocked" && task.blocked_reason === "capacity_unavailable" && fire.failure_code === "capacity_unavailable" && fire.attempts > 1)) return false;
      const queued = await tx.db.selectFrom("chat_queued_turns").select(["status", "claimed_run_id", "driver_kind"])
        .where("chat_id", "=", routine.chat_id).where("client_request_id", "=", botRoutineRequestId({ fireId: fire.fire_id, attempts: fire.attempts }))
        .forUpdate().executeTakeFirst();
      if (admission) {
        const run = await tx.db.selectFrom("chat_runs").select(["client_request_id", "driver_kind", "attempt", "status"])
          .where("id", "=", admission.runId).where("chat_id", "=", admission.chatId).executeTakeFirst();
        if (!run || run.client_request_id !== botRoutineRequestId({ fireId: fire.fire_id, attempts: fire.attempts })
          || run.driver_kind !== "matrix_bot" || run.attempt !== 1 || !["accepted", "running"].includes(run.status)) return false;
        if (queued && (queued.driver_kind !== "matrix_bot" || queued.status !== "claimed" || queued.claimed_run_id !== admission.runId)) return false;
      } else if (!queued || queued.status !== "queued" || queued.claimed_run_id || queued.driver_kind !== "matrix_bot") return false;
      // Locked unstarted task state proves this cannot renew a worker-owned run.
      // Admission gets a fresh execution lease; recovery renews waiting queues only.
      let update = tx.db.updateTable("bot_routine_fires")
        .set({ lease_expires_at: new Date(Date.parse(input.now) + 12 * 60000).toISOString(), updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("fire_id", "=", input.fireId)
        .where("status", "=", "dispatched");
      if (expiredBefore && !admission) update = update.where("lease_expires_at", "<=", expiredBefore);
      return Boolean(await update.returning("fire_id").executeTakeFirst());
    });
  }
  async function assertBinding(binding: BotRuntimeBinding, executor: BotExecutor = deps.db) {
    const scoped = createBotRoutinesRepository(executor),
      scopedTasks = createBotTasksRepository(executor);
    const fire = await scoped.forTask(binding.ownerId, binding.taskId);
    const routine = fire ? await scoped.get(binding.ownerId, fire.routineId) : undefined;
    const task = await scopedTasks.get({
      ownerId: binding.ownerId,
      taskId: binding.taskId
    });
    const source = routine?.authorization,
      b = binding.subscription;
    if (binding.requestClass !== "background" || binding.accessSourceId !== "matrix_chatgpt_plan" || !fire || fire.status !== "dispatched" || !fire.leaseExpiresAt || fire.leaseExpiresAt <= now() || !routine || !source || !b || routine.botId !== binding.botId || routine.chatId !== binding.chatId || !task || task.runId !== binding.runId || task.status !== "running" || b.accountId !== source.accountId || b.computerId !== source.computerId || b.grantRevision !== source.grantRevision || binding.route.modelId !== routine.proposal.selection.model || !(await deps.approvals.authorize(routine, executor))) throw new BotBrokerActionError("not_granted");
    return routine;
  }
  async function stopFire(ownerId: string, chatId: string, fire: NonNullable<Awaited<ReturnType<typeof repository.getFire>>>) {
    const owner = {
        type: "personal" as const,
        ownerId
      },
      task = await tasks.get({
        ownerId,
        taskId: fire.taskId
      });
    try {
      // A safe capacity retry retains the previous task runId until its queued attempt starts.
      // Cancel this fire/attempt's queue entry first; it never owns foreground work.
      if (canonical) {
        const queued = await deps.db.selectFrom("chat_queued_turns").select("id").where("chat_id", "=", chatId).where("client_request_id", "=", botRoutineRequestId(fire)).where("status", "=", "queued").executeTakeFirst();
        if (queued) {
          const chat = await canonical.repository.get(owner, chatId);
          if (!chat) throw new BotStateError("not_found");
          await canonical.repository.cancelQueuedTurn(owner, {
            chatId,
            queuedTurnId: queued.id,
            clientRequestId: `req_cancel_${fire.fireId}`,
            baseRevision: chat.chat.revision,
            cancelledAt: now()
          });
          await finish({
            ownerId,
            fireId: fire.fireId,
            status: "cancelled",
            now: now()
          });
          return;
        }
      }
      if (fire.status === "claimed" && fire.failureCode === "capacity_unavailable" && task?.status === "blocked" && task.blockedReason === "capacity_unavailable") {
        await finish({
          ownerId,
          fireId: fire.fireId,
          status: "cancelled",
          expectedStatus: "claimed",
          now: now()
        });
        return;
      }
      if (task?.runId) {
        if (!canonical) throw new BotStateError("invalid_transition");
        const currentRun = await deps.db.selectFrom("chat_runs").select("id").where("id", "=", task.runId).where("chat_id", "=", chatId).where("client_request_id", "=", botRoutineRequestId(fire)).executeTakeFirst();
        if (!currentRun) throw new BotStateError("invalid_transition");
        await canonical.orchestrator.cancelRun(owner, chatId, task.runId);
        // Canonical projection/ACK alone is not worker exit. Await its owned task/fire outcome, bounded.
        for (let pass = 0; pass < 100; pass++) {
          const current = await repository.getFire(ownerId, fire.fireId);
          if (!current || !["claimed", "dispatched"].includes(current.status)) return;
          const ended = await tasks.get({
            ownerId,
            taskId: fire.taskId
          });
          if (ended?.status === "cancelled") {
            await finish({
              ownerId,
              fireId: fire.fireId,
              status: "cancelled",
              now: now()
            });
            return;
          }
          await delay(100);
        }
        throw new BotStateError("invalid_transition");
      }
      await finish({
        ownerId,
        fireId: fire.fireId,
        status: "cancelled",
        now: now()
      });
    } catch (error: unknown) {
      console.warn("[bots] routine cancellation unconfirmed", error instanceof Error ? error.name : "UnknownError");
      await finish({
        ownerId,
        fireId: fire.fireId,
        status: "uncertain",
        failureCode: "cancel_unconfirmed",
        now: now()
      });
    }
  }
  return {
    describeChatPhase: (binding: BotRuntimeBinding) => describeRoutineChatPhase(deps.db, deps.approvals, binding, now()),
    approvalReply: (scope: Parameters<typeof routineApprovalReply>[1]) => routineApprovalReply(deps.db, scope, now()),
    connect(value: Canonical) {
      canonical = value;
    },
    ...createBotRoutineManagement(deps.db, deps.approvals),
    async start(value: Canonical) {
      canonical = value;
      if (scheduler || deps.available?.() === false) return;
      scheduler = createBotRoutineScheduler({
        repository: {
          ...repository,
          recover: async input => { await reconcileCancelledQueue(); return repository.recover(input, async candidate => await renewUnstartedLease(candidate) ? false : finish(candidate)); },
          finish
        },
        authorize: deps.approvals.authorize,
        run: createBotRoutineCanonicalRunner(value),
        now: deps.now
      });
      await scheduler.start();
    },
    async stop() {
      await scheduler?.stop();
    },
    propose: deps.approvals.propose,
    requestEdit: deps.approvals.requestEdit,
    async prepareRun(input: RunIdentity) {
      const run = await readRun(input);
      if (!run || !run.client_request_id.startsWith("req_routine_") && !run.original_request_id.startsWith("req_routine_")) return undefined;
      if (input.owner.type !== "personal" || run.driver_kind !== "matrix_bot" || run.attempt !== 1
        || run.client_request_id !== run.original_request_id) throw new BotBrokerActionError("not_granted");
      const identity = /^req_routine_(fire_[a-f0-9]{24})(?:_a([23]))?$/.exec(run.client_request_id);
      if (!identity) throw new BotBrokerActionError("not_granted");
      const fireId = identity[1],
        attempt = Number(identity[2] ?? 1);
      const fire = await repository.getFire(input.owner.ownerId, fireId),
        routine = fire ? await repository.get(input.owner.ownerId, fire.routineId) : undefined;
      const task = fire ? await tasks.get({
        ownerId: input.owner.ownerId,
        taskId: fire.taskId
      }) : undefined;
      if (!fire || fire.status !== "dispatched" || !fire.leaseExpiresAt || !routine?.authorization || routine.chatId !== input.chatId || !task || fire.attempts !== attempt || !(task.status === "queued" && !task.runId && attempt === 1 || task.status === "blocked" && task.blockedReason === "capacity_unavailable" && fire.failureCode === "capacity_unavailable" && attempt > 1) || !(await deps.approvals.authorize(routine))) throw new BotBrokerActionError("not_granted");
      if (!await renewUnstartedLease({ ownerId: input.owner.ownerId, fireId: fire.fireId, now: now() },
        { chatId: input.chatId, runId: input.runId, attempt, routineRevision: routine.revision })) throw new BotBrokerActionError("not_granted");
      return {
        backgroundTaskId: fire.taskId,
        selection: routineSelection(routine.proposal, routine.authorization),
        text: routine.proposal.prompt
      };
    },
    async completeRun(input: RunIdentity, result: BotTurnResult, options: { beforeTaskState?: boolean } = {}): Promise<BotTurnResult | void> {
      if (input.owner.type !== "personal") return;
      if (options.beforeTaskState) {
        const run = await readRun(input);
        if (run?.original_request_id.startsWith("req_routine_")
          && (run.attempt !== 1 || run.client_request_id !== run.original_request_id)) return { status: "failed" };
        const identity = /^req_routine_(fire_[a-f0-9]{24})(?:_a([23]))?$/.exec(run?.client_request_id ?? "");
        if (identity && await finish({ ownerId: input.owner.ownerId, fireId: identity[1], status: result.status === "cancelled" ? "cancelled" : "failed", ...(result.status === "cancelled" ? {} : { failureCode: "run_start_failed" }), expectedStatus: "dispatched", now: now() }, { kind: "canonical_run", chatId: input.chatId, runId: input.runId, attempt: Number(identity[2] ?? 1) })) {
          const persisted = await repository.getFire(input.owner.ownerId, identity[1]);
          return { status: persisted?.status === "uncertain" ? "uncertain" : persisted?.status === "cancelled" ? "cancelled" : "failed" };
        }
      }
      const task = await deps.db.selectFrom("bot_tasks").select(["task_id", "status", "blocked_reason"]).where("owner_id", "=", input.owner.ownerId).where("chat_id", "=", input.chatId).where("run_id", "=", input.runId).executeTakeFirst();
      const fire = task ? await repository.forTask(input.owner.ownerId, task.task_id) : undefined;
      if (!fire) return;
      const canonicalRun = await deps.db.selectFrom("chat_runs").select("client_request_id").where("id", "=", input.runId).where("chat_id", "=", input.chatId).executeTakeFirst();
      if (canonicalRun?.client_request_id !== botRoutineRequestId(fire)) return;
      if (fire.status === "uncertain") return {
        status: "uncertain"
      };
      if (fire.status !== "dispatched") return;
      if (result.retryableBeforeDispatch && result.status === "blocked" && result.blockedReason === "capacity_unavailable" && task?.status === "blocked" && task.blocked_reason === "capacity_unavailable") {
        if (fire.attempts < 3) await repository.defer({
          ownerId: input.owner.ownerId,
          fireId: fire.fireId,
          retryAfter: new Date(Date.parse(now()) + 30_000 * fire.attempts).toISOString(),
          now: now()
        });else await finish({
          ownerId: input.owner.ownerId,
          fireId: fire.fireId,
          status: "failed",
          failureCode: "capacity_exhausted",
          now: now()
        });
        return;
      }
      const humanActionRequired = result.status === "waiting_person" || result.status === "completed" && task?.status === "waiting_person";
      const status = humanActionRequired ? "failed" : result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : result.status === "uncertain" ? "uncertain" : "failed";
      await finish({
        ownerId: input.owner.ownerId,
        fireId: fire.fireId,
        status,
        ...(status === "failed" ? {
          failureCode: humanActionRequired ? "human_action_required" : result.blockedReason ?? "run_failed"
        } : status === "uncertain" ? {
          failureCode: "outcome_unknown"
        } : {}),
        now: now()
      });
      const finalized = await repository.getFire(input.owner.ownerId, fire.fireId);
      if (finalized?.status === "uncertain") return { status: "uncertain" };
      if (finalized?.status === "failed" && humanActionRequired) return { status: "failed" };
    },
    assertBinding,
    async assertOccurrencePhase(binding: BotRuntimeBinding) {
      const routine = await assertBinding(binding);
      return assertCurrentRoutinePhase(deps.db, binding, routine, now);
    },
    async assertTool(binding: BotRuntimeBinding, request: BotToolRequest) {
      const routine = await assertBinding(binding);
      const effect = request.capability === "integration.call" ? effectOf(request.args.service, request.args.action) : ["artifact.read", "memory.search", "integration.inventory", "integration.describe"].includes(request.capability) ? "read" : ["artifact.write", "memory.propose", "interaction.create"].includes(request.capability) ? "write" : undefined;
      if (!effect || !routine.proposal.authorizedEffects.some(allowed => allowed === effect)) throw new BotBrokerActionError("not_granted");
    },
    async list(ownerId: string, botId: string) {
      const routines = await repository.list(ownerId, botId);
      return Promise.all(routines.map(async r => {
        const fires = await repository.fires(ownerId, r.routineId);
        return {
          routineId: r.routineId,
          name: r.proposal.name,
          schedule: r.proposal.schedule,
          status: r.status,
          nextFireAt: r.nextFireAt,
          revision: r.revision,
          lastFire: fires.length > 0 ? fires[0] : null,
          requiresReview: fires.some(fire => fire.status === "uncertain")
        };
      }));
    },
    async control(ownerId: string, botId: string, routineId: string, raw: unknown) {
      const input = BotRoutineControlSchema.parse(raw),
        existing = await repository.get(ownerId, routineId);
      if (!existing || existing.botId !== botId) throw new BotStateError("not_found");
      if (input.status === "active") {
        if ((await repository.fires(ownerId, routineId)).some(fire => fire.status === "uncertain")) throw new BotStateError("conflict");
        if (!(await deps.approvals.authorize({
          ...existing,
          status: "active"
        }))) throw new BotStateError("invalid_input");
      }
      const routine = await transact(ownerId, async tx => {
        const r = await repository.control({
          ownerId,
          routineId,
          ...input,
          now: now()
        }, tx.db);
        await tx.publish(r.chatId, "bot.authority.changed", {
          agentId: botId,
          revision: r.revision
        });
        return r;
      });
      if (input.status !== "active") for (const fire of await repository.fires(ownerId, routineId)) if (fire.status === "claimed" || fire.status === "dispatched") await stopFire(ownerId, routine.chatId, fire);
      return routine;
    }
  };
}
export type BotRoutineExecution = ReturnType<typeof createBotRoutineExecution>;
