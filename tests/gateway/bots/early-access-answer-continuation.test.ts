import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotModelRoute } from "@matrix-os/contracts";
import { createBotAccessHandlers } from "../../../packages/gateway/src/bots/access-handlers.js";
import { createBotConnections } from "../../../packages/gateway/src/bots/connections.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotInteractionService, type BotContinuation } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotRecipeCatalog, type BotRecipe } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { beginBotTask } from "../../../packages/gateway/src/bots/task-begin.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { chatContextRequestHash } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OWNER, OTHER_OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_early_access";
const SOURCE_RUN = "run_access_source";
const ANSWER_RUN = "run_access_answer";
const RUNTIME = `runtime_${"e".repeat(32)}`;
const ACCOUNT = { connectionId: "conn_work", service: "gmail", label: "Work" };
const ROUTE: BotModelRoute = { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 };
const RECIPE: BotRecipe = {
  recipeId: "early-access", version: "1", name: "Access Bot", description: "Helps with mail.", instructions: "Help with mail.",
  capabilities: ["integration.inventory", "integration.call", "interaction.create"],
  integrations: [{ service: "gmail", effects: ["read", "send"], required: true }], output: "A reply.",
};
const AGENT = { id: BOT, name: "Access Bot", description: "", instructions: "Help with mail.", archived: false,
  selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: RECIPE.recipeId, version: RECIPE.version },
  revision: 1, createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" };
const READ = { service: "gmail", action: "list_threads", connectionId: ACCOUNT.connectionId, params: {} };
const SEND = { service: "gmail", action: "send_email", connectionId: ACCOUNT.connectionId,
  params: { to: "synthetic@example.com", subject: "Hello", body: "Synthetic test mail" } };
type Kind = "account_choice" | "approval" | "connected_account_choice";
type Admission = "queued" | "accepted";

let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>, clock: number;
const now = () => new Date(clock);
const transact = () => createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  clock = Date.parse("2026-10-27T00:00:00.000Z");
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: now().toISOString() });
});
afterEach(async () => { await destroy(); });

function requestHash(text: string) {
  return chatContextRequestHash({ parts: [{ type: "text", text }], selection: MATRIX_BOT_SELECTION,
    interactionMode: "default", permissionMode: "default" });
}

async function recordAnswer(continuation: BotContinuation, admission: Admission) {
  const at = now().toISOString(), text = continuation.text;
  if (admission === "queued") {
    await db.insertInto("chat_queued_turns").values({ id: "queued_access_answer", chat_id: CHAT,
      client_request_id: continuation.clientRequestId, position: 1, status: "queued", parts: JSON.stringify([{ type: "text", text }]),
      driver_kind: "matrix_bot", instance_id: MATRIX_BOT_SELECTION.instanceId, selection: JSON.stringify(MATRIX_BOT_SELECTION),
      interaction_mode: "default", permission_mode: "default", execution_root: null, execution_root_fingerprint: null,
      request_hash: requestHash(text), capability_snapshot: JSON.stringify({}), claimed_turn_id: null, claimed_run_id: null,
      cancelled_at: null, created_at: at, updated_at: at }).execute();
    return;
  }
  await db.transaction().execute(async tx => {
    await tx.insertInto("chat_messages").values({ id: "msg_access_answer", chat_id: CHAT, seq: 1, role: "user",
      purpose: "ai_request", state: "committed", turn_id: null, run_id: null, actor_id: OWNER,
      parts: JSON.stringify([{ type: "text", text }]), byte_count: Buffer.byteLength(text), search_text: text, created_at: at }).execute();
    await tx.insertInto("chat_turns").values({ id: "cturn_access_answer", chat_id: CHAT,
      client_request_id: continuation.clientRequestId, base_message_seq: 0, input_message_id: "msg_access_answer",
      status: "accepted", created_at: at, updated_at: at }).execute();
    await tx.insertInto("chat_runs").values({ id: ANSWER_RUN, chat_id: CHAT, turn_id: "cturn_access_answer",
      client_request_id: continuation.clientRequestId, attempt: 1, request_hash: requestHash(text), driver_kind: "matrix_bot",
      instance_id: MATRIX_BOT_SELECTION.instanceId, selection: JSON.stringify(MATRIX_BOT_SELECTION), interaction_mode: "default",
      permission_mode: "default", execution_root: null, execution_root_fingerprint: null, status: "accepted", outcome: null,
      started_at: null, completed_at: null, history_boundary_seq: 0, capability_snapshot: JSON.stringify({}), created_at: at, updated_at: at }).execute();
  });
}

async function setup(kind: Kind, admission: Admission = "queued", beforeFinish?: () => Promise<void>) {
  const transactions = transact(), registry = new BotRuntimeRegistry(), recipes = createBotRecipeCatalog([RECIPE]);
  const agents = { get: vi.fn(async () => AGENT) };
  const call = vi.fn(async () => ({ data: { id: "synthetic_result" }, summary: "Done" }));
  let connected = kind === "connected_account_choice" ? [] : [ACCOUNT];
  const client = { inventory: async () => connected, call };
  const tools = createBotIntegrationTools({ client, transact: transactions, recipes, agents, now });
  const interactions = createBotInteractionService({ transact: transactions, handlers: createBotAccessHandlers({ tools, now }), now });
  if (kind === "approval") await createBotGrantsRepository(db).grant({ ownerId: OWNER, botId: BOT, ...ACCOUNT,
    accountLabel: ACCOUNT.label, effects: ["read", "send"], audience: "direct", grantedByActorId: OWNER, now: now().toISOString() });
  let continuation: BotContinuation | undefined, sourceTaskId = "", interactionId = "";
  const runBot = vi.fn(async (input: { runtimeHandle: string; executionGeneration: string;
    command: { kind: string; runId: string } }) => {
    if (input.command.kind !== "bot.run") return { ok: true as const, reply: {} };
    const binding = registry.lookupRun({ ...input, runId: input.command.runId }) as BotRuntimeBinding;
    if (input.command.runId === SOURCE_RUN) {
      sourceTaskId = binding.taskId;
      expect((await createBotTasksRepository(db).get({ ownerId: OWNER, taskId: sourceTaskId }))?.status).toBe("running");
      await tools.call(binding, kind === "approval" ? SEND : READ);
      let [pending] = await interactions.listPending(OWNER, CHAT);
      if (kind === "connected_account_choice") {
        expect(pending?.kind).toBe("connect_request");
        connected = [ACCOUNT, { ...ACCOUNT, connectionId: "conn_home", label: "Home" }];
        const connections = createBotConnections({ client: { ...client, connect: async () => "https://example.com/connect", sync: async () => {} },
          tools, transact: transactions, now });
        await connections.startConnect(OWNER, CHAT, pending!.interactionId, pending!.revision);
        [pending] = await interactions.listPending(OWNER, CHAT);
      }
      expect(pending?.kind).toBe(kind === "approval" ? "approval" : "account_choice");
      interactionId = pending!.interactionId;
      const resolved = await interactions.resolve(OWNER, CHAT, interactionId, kind === "approval"
        ? { kind, baseRevision: 1, decision: "approve" } : { kind: "account_choice", baseRevision: 1, connectionId: ACCOUNT.connectionId });
      continuation = resolved.continuation!;
      expect(call).not.toHaveBeenCalled();
      await recordAnswer(continuation, admission);
      await beforeFinish?.();
    } else {
      expect(binding.taskId).toBe(sourceTaskId);
      await tools.call(binding, kind === "approval" ? SEND : READ);
    }
    return { ok: true as const, reply: { runId: input.command.runId, status: "completed", toolActions: 1, sessionRevision: 1 } };
  });
  const orchestrator = createBotTaskOrchestrator({ expectedOwnerId: OWNER, bindings: createBotBindingsRepository(db), transact: transactions,
    agents, recipes, interactions, resolveRoute: async () => ({ route: ROUTE, accessSourceId: "matrix_included" }),
    registry, now, admission: {
      admit: async input => {
        registry.bind({ ...input, runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "f".repeat(64) });
        return { runtimeHandle: RUNTIME, executionGeneration: "1", rootFingerprint: "f".repeat(64) };
      }, release: async handle => { registry.release(handle); }, startRenewal: () => ({ stop: async () => {} }),
    }, client: { runBot: runBot as never } });
  return { orchestrator, call, runBot, interactions,
    saved: () => ({ continuation: continuation!, sourceTaskId, interactionId }),
    task: () => createBotTasksRepository(db).get({ ownerId: OWNER, taskId: sourceTaskId }),
    start: (runId = SOURCE_RUN, text = "Help with mail.", signal = new AbortController().signal) => orchestrator.start({
      ownerId: OWNER, chatId: CHAT, runId, text, selection: MATRIX_BOT_SELECTION, signal }),
  };
}

it.each([
  ["account_choice", "queued"], ["account_choice", "accepted"], ["approval", "queued"], ["approval", "accepted"],
  ["connected_account_choice", "queued"], ["connected_account_choice", "accepted"],
] as const)("continues an early %s answer with %s admission in the exact source task, then completes", async (kind, admission) => {
  const context = await setup(kind, admission);
  expect(await context.start().result).toEqual({ status: "completed" });
  expect(await context.task()).toMatchObject({ status: "waiting_person", runId: SOURCE_RUN });
  const { continuation, sourceTaskId, interactionId } = context.saved();
  const saved = await db.selectFrom("bot_interactions").selectAll().where("interaction_id", "=", interactionId).executeTakeFirstOrThrow();
  expect(saved).toMatchObject({ source_run_id: SOURCE_RUN, status: "resolved", task_id: sourceTaskId });
  expect(continuation.clientRequestId).toBe(`req_answer_${interactionId}`);
  if (admission === "queued") await recordAnswer(continuation, "accepted");
  expect(await context.start(ANSWER_RUN, continuation.text).result).toEqual({ status: "completed" });
  expect(await context.task()).toMatchObject({ taskId: sourceTaskId, status: "completed", runId: ANSWER_RUN });
  expect(context.call).toHaveBeenCalledTimes(1);
  expect(await db.selectFrom("bot_tasks").select("task_id").execute()).toHaveLength(1);
  expect(await db.selectFrom("chat_runs").select(["client_request_id", "request_hash"]).where("id", "=", ANSWER_RUN)
    .executeTakeFirstOrThrow()).toEqual({ client_request_id: continuation.clientRequestId, request_hash: requestHash(continuation.text) });
});

it.each(["account_choice", "approval"] as const)("keeps Stop final after an early %s answer", async kind => {
  const abort = new AbortController();
  const context = await setup(kind, "accepted", async () => { abort.abort(); });
  expect(await context.start(SOURCE_RUN, "Help with mail.", abort.signal).result).toEqual({ status: "cancelled" });
  expect(await context.task()).toMatchObject({ status: "cancelled", runId: SOURCE_RUN });
  const { continuation } = context.saved();
  expect(await context.start(ANSWER_RUN, continuation.text).result).toEqual({ status: "failed" });
  expect(context.call).not.toHaveBeenCalled();
  expect(await context.task()).toMatchObject({ status: "cancelled", runId: SOURCE_RUN });
});

it.each(["account_choice", "approval"] as const)("does not wait for an early %s answer that expired before settlement", async kind => {
  const context = await setup(kind, "accepted", async () => { clock += 24 * 60 * 60_000; });
  await context.start().result;
  expect(await context.task()).toMatchObject({ status: "completed", runId: SOURCE_RUN });
  expect(await context.start(ANSWER_RUN, context.saved().continuation.text).result).toEqual({ status: "failed" });
  expect(context.call).not.toHaveBeenCalled();
});

it.each(["account_choice", "approval"] as const)("rejects an old %s answer after the task reaches another run", async kind => {
  const tasks = createBotTasksRepository(db), interactions = createBotInteractionsRepository(db), at = now().toISOString();
  const task = await tasks.start({ ownerId: OWNER, botId: BOT, chatId: CHAT, runId: SOURCE_RUN, now: at });
  const { interaction } = await interactions.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId,
    sourceRunId: SOURCE_RUN, kind, payload: kind === "account_choice"
      ? { kind, service: "gmail", access: ["read"], options: [{ connectionId: ACCOUNT.connectionId, label: ACCOUNT.label }] }
      : { kind, tool: "integration.call", argsDigest: "a".repeat(64), audience: "direct", preview: "Send synthetic mail", policyRevision: 1 },
    responderActorId: OWNER, blocking: true, expiresAt: new Date(clock + 60_000).toISOString(), now: at });
  const continuation = { chatId: CHAT, clientRequestId: `req_answer_${interaction.interactionId}`, text: "Exact original decision." };
  await interactions.resolve({ ownerId: OWNER, interactionId: interaction.interactionId, responderActorId: OWNER,
    baseRevision: interaction.revision, resolution: { continuation: continuation.text }, now: at });
  const waiting = await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision,
    to: "waiting_person", now: at });
  await recordAnswer(continuation, "accepted");
  const running = await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: waiting.revision,
    to: "running", runId: "run_later_question", now: now().toISOString() });
  await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: running.revision, to: "waiting_person", now: now().toISOString() });
  await expect(transact()(OWNER, tx => beginBotTask(tx, { ownerId: OWNER, botId: BOT, chatId: CHAT,
    runId: ANSWER_RUN, text: continuation.text, now: now().toISOString() }))).rejects.toMatchObject({ code: "conflict" });
  expect(await tasks.get({ ownerId: OWNER, taskId: task.taskId })).toMatchObject({ status: "waiting_person", runId: "run_later_question" });
});

it.each(["owner", "bot", "text"] as const)("rejects substituted %s authority before dispatching an early access answer", async changed => {
  const context = await setup("account_choice", "accepted");
  await context.start().result;
  const { continuation } = context.saved();
  await expect(transact()(OWNER, tx => beginBotTask(tx, { ownerId: changed === "owner" ? OTHER_OWNER : OWNER,
    botId: changed === "bot" ? "bot_ffffffffffffffff" : BOT, chatId: CHAT, runId: ANSWER_RUN,
    text: changed === "text" ? "Use a different account." : continuation.text, now: now().toISOString() })))
    .rejects.toBeDefined();
  expect(context.call).not.toHaveBeenCalled();
});
