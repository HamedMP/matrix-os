/** Real pooled PostgreSQL only. No server, provider, scope worker or model is started here.
 * The existing harness owns a random schema; the external source is a deliberate test double.
 * These helpers are inert until an explicitly enabled PG test invokes them.
 */
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { expect } from "vitest";
import type { BotRoutineProposal } from "../../../packages/contracts/src/bots/routines.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import { BOT, NOW, OWNER, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";
export { BOT, OWNER };
export const PG_CHAT = "chat_routine_pg";
export const PG_AT = "2026-09-27T12:01:00.000Z";
export const PG_LATER = "2026-09-27T12:16:00.000Z";
export const PG_NEXT = "2026-09-27T12:02:00.000Z";
export const pgEnabled = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);
export const pgProposal: BotRoutineProposal = {
  name: "PG fixture",
  prompt: "Read the synthetic fixture only",
  schedule: {
    kind: "interval",
    everyMs: 60_000
  },
  selection: {
    instanceId: "matrix_chatgpt_plan",
    model: "fixture-model"
  },
  authorizedEffects: ["read"]
};
export function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {
    promise,
    resolve
  };
}
export async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PG fixture barrier timed out")), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function backendPid(db: Kysely<OwnerBotDatabase> | Transaction<OwnerBotDatabase>) {
  return (await sql<{
    pid: number;
  }>`SELECT pg_backend_pid() AS pid`.execute(db)).rows[0]!.pid;
}
export async function expectBlocked(db: Kysely<OwnerBotDatabase>, waiter: number, blocker: number) {
  expect(waiter).not.toBe(blocker);
  for (let pass = 0; pass < 100; pass++) {
    const row = (await sql<{
      pids: number[];
    }>`SELECT pg_blocking_pids(${waiter}) AS pids`.execute(db)).rows[0]!;
    if (row.pids.includes(blocker)) return;
    await delay(10);
  }
  throw new Error("Expected a distinct PostgreSQL backend blocked by the held routine row");
}

/** Proves the contender is actually blocked in PG before committing the holder's mutation.
 * Both branches settle even if a lock assertion fails; no arbitrary sleep proves ordering.
 */
export async function behindRoutineLock<T>(fixture: PgRoutineFixture, contender: (tx: Transaction<OwnerBotDatabase>) => Promise<T>, mutate: (tx: Transaction<OwnerBotDatabase>) => Promise<unknown> = async () => undefined): Promise<T> {
  let pending: Promise<{
    ok: true;
    value: T;
  } | {
    ok: false;
    error: unknown;
  }> | undefined;
  try {
    await fixture.db.transaction().execute(async holder => {
      const holderPid = await backendPid(holder);
      await holder.selectFrom("bot_routines").select("routine_id").where("owner_id", "=", OWNER).where("routine_id", "=", fixture.routine.routineId).forUpdate().executeTakeFirstOrThrow();
      const entered = barrier<number>();
      pending = fixture.db.transaction().execute(async tx => {
        entered.resolve(await backendPid(tx));
        return contender(tx);
      }).then(value => ({
        ok: true as const,
        value
      }), error => ({
        ok: false as const,
        error
      }));
      await expectBlocked(fixture.db, await bounded(entered.promise), holderPid);
      await mutate(holder);
    });
  } finally {
    if (pending) await pending;
  }
  if (!pending) throw new Error("PG contender was not started");
  const result = await pending;
  if (!result.ok) throw result.error;
  return result.value;
}
export async function createPgRoutineFixture() {
  const real = await createRealBotStateDatabase();
  const db = real.db,
    chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const transact = createBotStateTransactions(chats),
    repo = createBotRoutinesRepository(db),
    tasks = createBotTasksRepository(db);
  let clock = NOW;
  // External device/source and file definition are doubles. All routine/approval/task/outbox state is real PG.
  const source = {
    enabled: true,
    background: true,
    accountId: "fixture-account",
    computerId: "fixture-computer",
    grantRevision: 3,
    definitionRevision: 1
  };
  const subscription = {
    accountId: source.accountId,
    computerId: source.computerId,
    grantRevision: 3,
    peerId: "f2b7ba8f-009b-4603-8967-c3e6bdfb276e"
  };
  const route = {
    api: "openai-responses" as const,
    modelId: "fixture-model",
    input: ["text" as const],
    contextWindow: 8192,
    maxOutputTokens: 256
  };
  const approvals = createBotRoutineApprovals({
    db,
    transact,
    now: () => new Date(clock),
    definitionRevision: async () => source.definitionRevision,
    source: {
      resolve: async (selection, ownerId, requestClass) => {
        if (ownerId !== OWNER || requestClass !== "background" || !source.enabled || !source.background || selection?.model !== "fixture-model" || selection.options?.find(o => o.id === "accountId")?.value !== source.accountId || selection.options?.find(o => o.id === "grantRevision")?.value !== String(source.grantRevision)) throw new Error("Fixture source refused");
        return {
          route,
          accessSourceId: "matrix_chatgpt_plan",
          subscription: {
            ...subscription,
            ...source
          }
        };
      }
    }
  });
  try {
    await insertChat(db, PG_CHAT);
    await createBotBindingsRepository(db).bindDirect({
      ownerId: OWNER,
      botId: BOT,
      chatId: PG_CHAT,
      now: NOW
    });
    const proposalTask = await tasks.create({
      ownerId: OWNER,
      botId: BOT,
      chatId: PG_CHAT,
      now: NOW
    });
    await tasks.transition({
      ownerId: OWNER,
      taskId: proposalTask.taskId,
      baseRevision: 1,
      to: "running",
      runId: "run_pg_proposal",
      now: NOW
    });
    const binding: BotRuntimeBinding = {
      runtimeHandle: "runtime_" + "f".repeat(32),
      executionGeneration: "1",
      ownerId: OWNER,
      botId: BOT,
      chatId: PG_CHAT,
      taskId: proposalTask.taskId,
      runId: "run_pg_proposal",
      rootFingerprint: "a".repeat(64),
      route,
      accessSourceId: "matrix_chatgpt_plan",
      subscription,
      capabilities: [],
      requestClass: "interactive"
    };
    const pending = await approvals.propose(binding, pgProposal);
    const interaction = (await createBotInteractionsRepository(db).get({
      ownerId: OWNER,
      interactionId: pending.interactionId
    }))!;
    const interactions = createBotInteractionService({
      transact,
      now: () => new Date(clock),
      handlers: {
        chooseAccount: async () => {
          throw new Error("No external account interaction in PG fixture");
        },
        decideApproval: approvals.decide
      }
    });
    await interactions.resolve(OWNER, PG_CHAT, pending.interactionId, {
      kind: "approval",
      decision: "approve",
      baseRevision: interaction.revision
    });
    const routine = (await repo.list(OWNER, BOT))[0]!;
    const execution = (override?: BotStateTransactions) => createBotRoutineExecution({
      db,
      approvals,
      transact: override ?? transact,
      now: () => new Date(clock)
    });
    return {
      db,
      chats,
      transact,
      repo,
      tasks,
      approvals,
      source,
      routine,
      binding,
      execution,
      executionIn(tx: Transaction<OwnerBotDatabase>) {
        return createBotRoutineExecution({
          db: tx,
          approvals,
          transact: createBotStateTransactions(new ChatRepository(tx as unknown as Kysely<ChatDatabase>, true)),
          now: () => new Date(clock)
        });
      },
      setClock(value: string) {
        clock = value;
      },
      async claim() {
        const fire = await repo.claim({
          ownerId: OWNER,
          routineId: routine.routineId,
          scheduledFor: PG_AT,
          nextFireAt: PG_NEXT,
          now: PG_AT
        });
        if (!fire) throw new Error("PG fixture did not claim a fire");
        clock = PG_AT;
        return fire;
      },
      async running(fireId: string, options: { startTask?: boolean } = {}) {
        await repo.dispatch({
          ownerId: OWNER,
          fireId,
          now: PG_AT
        });
        const fire = (await repo.getFire(OWNER, fireId))!;
        const hex = randomUUID().replaceAll("-", ""),
          runId = `run_pg_${hex}`,
          turnId = `cturn_pg_${hex}`,
          messageId = `msg_pg_${hex}`;
        const owner = {
            type: "personal" as const,
            ownerId: OWNER
          },
          record = (await chats.get(owner, PG_CHAT))!;
        await chats.admitTurn(owner, {
          chatId: PG_CHAT,
          baseRevision: record.chat.revision,
          message: {
            id: messageId,
            chatId: PG_CHAT,
            turnId,
            seq: 1,
            role: "user",
            state: "committed",
            parts: [{
              type: "text",
              text: pgProposal.prompt
            }],
            createdAt: PG_AT
          },
          turn: {
            id: turnId,
            chatId: PG_CHAT,
            clientRequestId: `req_routine_${fireId}`,
            baseMessageSeq: 0,
            inputMessageId: messageId,
            status: "accepted",
            createdAt: PG_AT,
            updatedAt: PG_AT
          },
          run: {
            id: runId,
            chatId: PG_CHAT,
            turnId,
            attempt: 1,
            driverKind: "matrix_bot",
            instanceId: "matrix_bot_default",
            selection: {
              instanceId: "matrix_bot_default",
              model: "auto"
            },
            interactionMode: "default",
            permissionMode: "default",
            status: "accepted",
            historyBoundarySeq: 0,
            capabilitySnapshot: {
              revision: "pg_fixture",
              rootChat: true,
              attachments: [],
              resources: [],
              tools: [],
              approvals: true,
              userInput: true,
              resume: false,
              cancellation: true,
              worktrees: "none",
              interactionModes: ["default"],
              permissionModes: ["default"]
            },
            createdAt: PG_AT,
            updatedAt: PG_AT
          }
        });
        const task = (await tasks.get({
          ownerId: OWNER,
          taskId: fire.taskId
        }))!;
        if (options.startTask !== false) await tasks.transition({
          ownerId: OWNER,
          taskId: fire.taskId,
          baseRevision: task.revision,
          to: "running",
          runId,
          now: PG_AT
        });
        return {
          input: {
            owner,
            chatId: PG_CHAT,
            runId
          },
          binding: {
            ...binding,
            taskId: fire.taskId,
            runId,
            requestClass: "background" as const
          },
          fire
        };
      },
      async events() {
        return db.selectFrom("chat_outbox").select(["event_type", "payload", "cursor"]).where("owner_id", "=", OWNER).where("chat_id", "=", PG_CHAT).where("event_type", "in", ["bot.authority.changed", "bot.task.updated"]).orderBy("cursor").execute();
      },
      async recover(exec: ReturnType<typeof createBotRoutineExecution>) {
        const unavailable = async () => {
          throw new Error("A PG recovery fixture must never admit or cancel a real canonical run");
        };
        try {
          await exec.start({
            repository: chats,
            orchestrator: {
              admitTurn: unavailable,
              enqueueQueuedTurn: unavailable,
              cancelRun: unavailable
            }
          });
        } finally {
          await exec.stop();
        }
      },
      destroy: real.destroy
    };
  } catch (error: unknown) {
    await real.destroy();
    throw error;
  }
}
export type PgRoutineFixture = Awaited<ReturnType<typeof createPgRoutineFixture>>;
