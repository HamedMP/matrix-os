import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotRecipeCatalog, ROUTINE_DIRECT_CHAT_RECIPE } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { NOW, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const chatId = "chat_routine_" + "a".repeat(32);
const botId = "bot_routine" + "b".repeat(32);
const owner = { type: "personal" as const, ownerId: OWNER };
const runId = "run_internal_routine";
const text = "Process the schedule action.";
let data: Awaited<ReturnType<typeof createBotStateDatabase>>;
let chats: ChatRepository;

beforeEach(async () => {
  data = await createBotStateDatabase();
  chats = new ChatRepository(data.db as never);
  await insertChat(data.db, chatId);
  await createBotBindingsRepository(data.db).bindDirect({ ownerId: OWNER, botId, chatId, now: NOW });
});

afterEach(async () => {
  await chats?.release();
  await data?.destroy();
});

async function admit(clientRequestId: string) {
  const turnId = "cturn_internal_routine", messageId = "msg_internal_routine";
  await chats.admitTurn(owner, { chatId, baseRevision: 0,
    message: { id: messageId, chatId, turnId, seq: 1, role: "user", state: "committed", parts: [{ type: "text", text }], createdAt: NOW },
    turn: { id: turnId, chatId, clientRequestId, baseMessageSeq: 0, inputMessageId: messageId, status: "accepted", createdAt: NOW, updatedAt: NOW },
    run: { id: runId, chatId, turnId, attempt: 1, driverKind: "matrix_bot", instanceId: MATRIX_BOT_SELECTION.instanceId, selection: MATRIX_BOT_SELECTION,
      interactionMode: "default", permissionMode: "default", status: "accepted", historyBoundarySeq: 0, createdAt: NOW, updatedAt: NOW,
      capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true, userInput: true,
        resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] } },
  });
}

function setup(ports: Pick<Parameters<typeof createBotTaskOrchestrator>[0], "routineExecution" | "routineProposals">) {
  const registry = new BotRuntimeRegistry();
  const runBot = vi.fn(async () => ({ ok: true, reply: { runId, status: "completed", toolActions: 0, sessionRevision: 1 } }));
  const route = { route: { api: "anthropic-messages" as const, modelId: "fixture-model", input: ["text" as const], contextWindow: 128000, maxOutputTokens: 8192 },
    accessSourceId: "matrix_included" as const };
  const { name, description, instructions, recipeId, version } = ROUTINE_DIRECT_CHAT_RECIPE;
  const orchestrator = createBotTaskOrchestrator({
    ...ports,
    bindings: createBotBindingsRepository(data.db),
    transact: createBotStateTransactions(chats),
    routineTools: true,
    agents: { get: async () => ({ id: botId, name, description, instructions, selection: MATRIX_BOT_SELECTION,
      recipeRef: { recipeId, version }, archived: false, revision: 1, createdAt: NOW, updatedAt: NOW }) },
    recipes: createBotRecipeCatalog(),
    resolveRoute: async () => route,
    resolveRoutineProposalRoute: async () => route,
    registry,
    admission: {
      admit: async request => {
        const runtime = { runtimeHandle: "runtime_" + "f".repeat(32), executionGeneration: "1", rootFingerprint: "a".repeat(64) };
        registry.bind({ ...request, ...runtime });
        return runtime;
      },
      release: async handle => { registry.release(handle); },
      startRenewal: () => ({ stop: async () => undefined }),
    },
    client: { runBot: runBot as never },
    now: () => new Date(NOW),
  });
  return { runBot, run: () => orchestrator.start({ ownerId: OWNER, chatId, runId, text, signal: new AbortController().signal }).result };
}

it("never runs inference when a scheduler approval continuation lacks its durable reply", async () => {
  const tasks = createBotTasksRepository(data.db), interactions = createBotInteractionsRepository(data.db);
  const base = await tasks.create({ ownerId: OWNER, botId, chatId, now: NOW });
  const running = await tasks.transition({ ownerId: OWNER, taskId: base.taskId, baseRevision: base.revision, to: "running", runId: "run_original", now: NOW });
  await tasks.transition({ ownerId: OWNER, taskId: base.taskId, baseRevision: running.revision, to: "waiting_person", now: NOW });
  const { interaction } = await interactions.create({ ownerId: OWNER, botId, chatId, taskId: base.taskId, kind: "approval",
    payload: { kind: "approval", tool: "routine.activate", argsDigest: "a".repeat(64), audience: "direct", preview: "{}", policyRevision: 1 },
    responderActorId: OWNER, blocking: true, expiresAt: at(60_000), now: NOW });
  await interactions.resolve({ ownerId: OWNER, interactionId: interaction.interactionId, baseRevision: interaction.revision,
    responderActorId: OWNER, resolution: { decision: "approve", continuation: text }, now: NOW });
  await admit(`req_answer_${interaction.interactionId}`);

  const approvalReply = vi.fn(async () => null);
  const { run, runBot } = setup({ routineExecution: { approvalReply, assertOccurrencePhase: async () => { throw new Error("Unexpected occurrence"); } } });
  const result = await run();
  expect(approvalReply).toHaveBeenCalledOnce();
  expect(runBot).not.toHaveBeenCalled();
  expect(result.status).toBe("blocked");
});

it("never runs inference when a claimed scheduler proposal returns no durable result", async () => {
  await admit("req_cli_routine_" + "a".repeat(32));
  const consume = vi.fn(async () => undefined);
  const { run, runBot } = setup({ routineProposals: {
    beginWithin: async (tx, input) => {
      const tasks = createBotTasksRepository(tx.db);
      const base = await tasks.create({ ownerId: OWNER, botId, chatId, now: NOW }, tx.db);
      const task = await tasks.transition({ ownerId: OWNER, taskId: base.taskId, baseRevision: base.revision,
        to: "running", runId: input.runId, now: NOW }, tx.db);
      return { task, continued: false, routineProposalModel: "fixture-model" };
    },
    consume,
    recover: async () => false,
  } });
  const result = await run();
  expect(consume).toHaveBeenCalledOnce();
  expect(runBot).not.toHaveBeenCalled();
  expect(result.status).toBe("blocked");
});
