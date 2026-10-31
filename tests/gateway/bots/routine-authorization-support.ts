import type { ChatGptPlanAuthority } from "../../../packages/gateway/src/bots/chatgpt-plan.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";
export const CHAT = "chat_routine_approval",
  subscription = {
    accountId: "fixture-account",
    computerId: "fixture-computer",
    grantRevision: 3,
    peerId: "f2b7ba8f-009b-4603-8967-c3e6bdfb276e"
  };
export const proposal = {
  name: "Fixture brief",
  prompt: "Summarize approved fixtures",
  schedule: {
    kind: "interval",
    everyMs: 60000
  },
  selection: {
    instanceId: "matrix_chatgpt_plan",
    model: "fixture-model"
  },
  authorizedEffects: ["read"]
};
export let data: Awaited<ReturnType<typeof createBotStateDatabase>>, binding: BotRuntimeBinding;
beforeEach(async () => {
  data = await createBotStateDatabase();
  await insertChat(data.db, CHAT);
  await createBotBindingsRepository(data.db).bindDirect({
    ownerId: OWNER,
    botId: BOT,
    chatId: CHAT,
    now: NOW
  });
  const tasks = createBotTasksRepository(data.db),
    task = await tasks.create({
      ownerId: OWNER,
      botId: BOT,
      chatId: CHAT,
      now: NOW
    });
  await tasks.transition({
    ownerId: OWNER,
    taskId: task.taskId,
    baseRevision: task.revision,
    to: "running",
    runId: "run_proposal_fixture",
    now: NOW
  });
  binding = {
    runtimeHandle: "runtime_" + "f".repeat(32),
    executionGeneration: "1",
    ownerId: OWNER,
    botId: BOT,
    chatId: CHAT,
    taskId: task.taskId,
    runId: "run_proposal_fixture",
    rootFingerprint: "a".repeat(64),
    route: {
      api: "openai-responses",
      modelId: "fixture-model",
      input: ["text"],
      contextWindow: 1000,
      maxOutputTokens: 100
    },
    accessSourceId: "matrix_chatgpt_plan",
    subscription,
    capabilities: [],
    requestClass: "interactive"
  };
});
afterEach(async () => {
  await data?.destroy();
});
export function setup() {
  const resolve = vi.fn<ChatGptPlanAuthority["resolve"]>(async () => ({
    route: binding.route,
    accessSourceId: "matrix_chatgpt_plan",
    subscription
  }));
  const transact = createBotStateTransactions(new ChatRepository(data.db as never));
  const service = createBotRoutineApprovals({
    db: data.db,
    transact,
    source: {
      resolve
    } as never,
    definitionRevision: async () => 1,
    now: () => new Date(NOW)
  });
  const interactions = createBotInteractionService({
    transact,
    now: () => new Date(NOW),
    handlers: {
      chooseAccount: async () => {
        throw new Error("unavailable fixture");
      },
      decideApproval: service.decide
    }
  });
  return {
    service,
    interactions,
    resolve,
    repo: createBotRoutinesRepository(data.db)
  };
}
export async function activated(options: {
  dispatch?: boolean;
  recurring?: boolean;
} = {}) {
  const context = setup(),
    pending = await context.service.propose(binding, proposal);
  const record = await createBotInteractionsRepository(data.db).get({
    ownerId: OWNER,
    interactionId: pending.interactionId
  });
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {
    kind: "approval",
    decision: "approve",
    baseRevision: record!.revision
  });
  const [r] = await context.repo.list(OWNER, BOT),
    at = r.nextFireAt!;
  const f = (await context.repo.claim({
    ownerId: OWNER,
    routineId: r.routineId,
    scheduledFor: at,
    nextFireAt: options.recurring ? new Date(Date.parse(at) + 60000).toISOString() : null,
    now: at
  }))!;
  if (options.dispatch !== false) await context.repo.dispatch({
    ownerId: OWNER,
    fireId: f.fireId,
    now: at
  });
  return {
    ...context,
    r,
    f,
    at
  };
}
export async function admitFixture(fireId: string, clientRequestId = "req_routine_" + fireId, suffix = "") {
  const repository = new ChatRepository(data.db as never),
    owner = {
      type: "personal" as const,
      ownerId: OWNER
    },
    record = await repository.get(owner, CHAT);
  const turnId = "cturn_routine_fixture" + suffix,
    runId = "run_routine_fixture" + suffix,
    messageId = "msg_routine_fixture" + suffix;
  const capabilitySnapshot = {
    revision: "fixture",
    rootChat: true,
    attachments: [],
    resources: [],
    tools: [],
    approvals: true,
    userInput: true,
    resume: false,
    cancellation: true,
    worktrees: "none" as const,
    interactionModes: ["default"],
    permissionModes: ["default"]
  };
  await repository.admitTurn(owner, {
    chatId: CHAT,
    baseRevision: record!.chat.revision,
    message: {
      id: messageId,
      chatId: CHAT,
      turnId,
      seq: record!.chat.messageCount + 1,
      role: "user",
      state: "committed",
      parts: [{
        type: "text",
        text: "forged text must not execute"
      }],
      createdAt: NOW
    },
    turn: {
      id: turnId,
      chatId: CHAT,
      clientRequestId,
      baseMessageSeq: record!.chat.messageCount,
      inputMessageId: messageId,
      status: "accepted",
      createdAt: NOW,
      updatedAt: NOW
    },
    run: {
      id: runId,
      chatId: CHAT,
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
      historyBoundarySeq: record!.chat.messageCount,
      capabilitySnapshot,
      createdAt: NOW,
      updatedAt: NOW
    }
  });
  return {
    repository,
    owner,
    chatId: CHAT,
    runId
  };
}
