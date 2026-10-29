import { setTimeout as delay } from "node:timers/promises";
import type { Kysely } from "kysely";
import type { BotToolRequest, CanonicalOwnerScope } from "@matrix-os/contracts";
import { BotRoutineControlSchema } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { BotRoutineApprovals } from "./routine-approval.js";
import { routineSelection } from "./routine-authorization.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { createBotTasksRepository } from "./repositories/tasks.js";
import { BotStateError, type BotExecutor } from "./repositories/shared.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";
import type { BotTurnResult } from "./task-orchestrator.js";
import { effectOf } from "./integration-tools.js";
import { createBotRoutineCanonicalRunner, botRoutineRequestId } from "./continuations.js";
import { createBotRoutineScheduler } from "./routine-scheduler.js";
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
  const repository = createBotRoutinesRepository(deps.db),
    tasks = createBotTasksRepository(deps.db);
  const transact = deps.transact ?? createBotStateTransactions(new ChatRepository(deps.db as unknown as Kysely<ChatDatabase>));
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  let canonical: Canonical | undefined, scheduler: ReturnType<typeof createBotRoutineScheduler> | undefined;
  async function finish(input: Parameters<typeof repository.finish>[0]) {
    return transact(input.ownerId, async tx => {
      const scoped = createBotRoutinesRepository(tx.db);
      if (!(await scoped.finish(input))) return false;
      const fire = await scoped.getFire(input.ownerId, input.fireId);
      if (!fire) return false;
      const routine = await scoped.get(input.ownerId, fire.routineId);
      if (!routine) return;
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
    connect(value: Canonical) {
      canonical = value;
    },
    async start(value: Canonical) {
      canonical = value;
      if (scheduler || deps.available?.() === false) return;
      scheduler = createBotRoutineScheduler({
        repository: {
          ...repository,
          recover: input => repository.recover(input, finish),
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
    async prepareRun(input: RunIdentity) {
      const run = await deps.db.selectFrom("chat_runs").select(["client_request_id", "driver_kind", "attempt"]).where("id", "=", input.runId).where("chat_id", "=", input.chatId).executeTakeFirst();
      if (!run?.client_request_id.startsWith("req_routine_")) return undefined;
      if (input.owner.type !== "personal" || run.driver_kind !== "matrix_bot" || run.attempt !== 1) throw new BotBrokerActionError("not_granted");
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
      if (!fire || fire.status !== "dispatched" || !fire.leaseExpiresAt || fire.leaseExpiresAt <= now() || !routine?.authorization || routine.chatId !== input.chatId || !task || fire.attempts !== attempt || !(task.status === "queued" && !task.runId && attempt === 1 || task.status === "blocked" && task.blockedReason === "capacity_unavailable" && fire.failureCode === "capacity_unavailable" && attempt > 1) || !(await deps.approvals.authorize(routine))) throw new BotBrokerActionError("not_granted");
      return {
        backgroundTaskId: fire.taskId,
        selection: routineSelection(routine.proposal, routine.authorization),
        text: routine.proposal.prompt
      };
    },
    async completeRun(input: RunIdentity, result: BotTurnResult): Promise<BotTurnResult | void> {
      if (input.owner.type !== "personal") return;
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
      const status = result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : result.status === "uncertain" ? "uncertain" : "failed";
      await finish({
        ownerId: input.owner.ownerId,
        fireId: fire.fireId,
        status,
        ...(status === "failed" ? {
          failureCode: result.blockedReason ?? (result.status === "waiting_person" ? "human_action_required" : "run_failed")
        } : status === "uncertain" ? {
          failureCode: "outcome_unknown"
        } : {}),
        now: now()
      });
      if ((await repository.getFire(input.owner.ownerId, fire.fireId))?.status === "uncertain") return {
        status: "uncertain"
      };
    },
    assertBinding,
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
        const r = await createBotRoutinesRepository(tx.db).control({
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
