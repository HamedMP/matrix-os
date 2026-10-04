import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotToolRequest } from "@matrix-os/contracts";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../../../packages/gateway/src/bots/integration-client.js";
import { createBotIntegrationTools, effectOf } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotApprovalsRepository } from "../../../packages/gateway/src/bots/repositories/approvals.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_uncertain1";
const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
type CallArgs = Extract<BotToolRequest, { capability: "integration.call" }>["args"];
const CALLS: Array<{ name: string; args: CallArgs }> = [
  { name: "send", args: { service: "gmail", action: "send_email", connectionId: "conn_work", params: { to: "fixture@example.test", subject: "Fixture", body: "Synthetic only" } } },
  { name: "write", args: { service: "gmail", action: "create_label", connectionId: "conn_work", params: { name: "Fixture" } } },
];
const READ = { service: "gmail", action: "list_threads", connectionId: "conn_work", params: {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let binding: BotRuntimeBinding;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  binding = {
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT, chatId: CHAT,
    taskId: task.taskId, runId: "run_uncertain1", rootFingerprint: "f".repeat(64),
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4096 },
    accessSourceId: "matrix_included", capabilities: ["integration.call"], requestClass: "interactive",
  };
});
afterEach(async () => { vi.restoreAllMocks(); await destroy(); });

async function setup(call: BotIntegrationTransport, args: CallArgs = CALLS[0]!.args, options: { declared?: boolean; grant?: boolean; timeout?: boolean } = {}) {
  const registry = new BotRuntimeRegistry(); registry.bind(binding);
  let inventoryStatus = 200;
  const transport = vi.fn<BotIntegrationTransport>(async (ownerId, request) => {
    if (request.path === "/") return json([{ id: "conn_work", service: "gmail", account_label: "Work", status: "active" }], inventoryStatus);
    return call(ownerId, request);
  });
  const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const integrations = createBotIntegrationTools({ client: createBotIntegrationClient(transport), transact,
    recipes: createBotRecipeCatalog([{ recipeId: "fixture", version: "1", name: "Fixture", description: "Fixture", instructions: "Fixture",
      capabilities: ["integration.call"], integrations: [{ service: "gmail", effects: options.declared === false ? ["read"] : ["read", "write", "send"], required: true }], output: "Fixture" }]),
    agents: { get: async () => ({ id: BOT, recipeRef: { recipeId: "fixture", version: "1" } }) as never }, now: () => new Date(NOW),
  });
  if (options.grant !== false) {
    await createBotGrantsRepository(db).grant({ ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_work",
      accountLabel: "Work", effects: ["read", "write", "send"], audience: "direct", grantedByActorId: OWNER, now: NOW });
    if (options.declared !== false && effectOf(args.service, args.action) !== "read") {
      await integrations.call(binding, args);
      const approval = await db.selectFrom("bot_approvals").select(["approval_id", "revision"]).executeTakeFirstOrThrow();
      await createBotApprovalsRepository(db).decide({ ownerId: OWNER, approvalId: approval.approval_id,
        decision: "approved", baseRevision: Number(approval.revision), now: NOW });
    }
  }
  const checkpoints = createBotCheckpointsRepository(db);
  const broker = createBotBrokerActions({ db, registry, checkpoints, sessions: createBotSessionsRepository(db),
    tools: createBotToolDispatcher({ homePath: "/unused", integrations }),
    runs: { loadRunSpec: vi.fn(), readImageChunk: vi.fn() }, events: { publish: vi.fn() },
    inference: { homePath: "/unused", lifetime: new AbortController().signal, resolveCredentials: vi.fn() }, now: () => new Date(NOW),
    ...(options.timeout ? { toolTimeoutMs: 50 } : {}),
  });
  const frame = { version: 1, requestId: REQUEST_ID, runtimeHandle: binding.runtimeHandle, executionGeneration: "1", runId: binding.runId,
    action: "bot.tool", tool: { toolCallId: "call_fixture1", capability: "integration.call", args } };
  return { broker, registry, transport, frame, checkpoints, failInventory: () => { inventoryStatus = 503; } };
}

const failures: Array<{ name: string; call: BotIntegrationTransport }> = [
  { name: "network error", call: async () => { throw new TypeError("private provider error /secret"); } },
  { name: "transport cancellation", call: async () => { throw new DOMException("private provider error", "AbortError"); } },
  { name: "transport timeout", call: async () => { throw new DOMException("private provider error", "TimeoutError"); } },
  ...[500, 502, 503, 504].map(status => ({ name: `server ${status}`, call: async () => json({ error: "private provider error /secret" }, status) })),
  { name: "malformed JSON", call: async () => new Response("private provider error /secret") },
  { name: "invalid success envelope", call: async () => json({ summary: "missing data" }) },
  { name: "oversized response", call: async () => new Response("private provider error /secret", { headers: { "content-length": String(300 * 1024) } }) },
  { name: "response body failure", call: async () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("private provider error /secret")); } })) },
];

describe.each(CALLS)("integration $name uncertainty through client/tools/broker", ({ args }) => {
  it.each(failures)("records dispatched $name as unknown and refuses replay", async ({ call }) => {
    const { broker, transport, frame, checkpoints } = await setup(call, args);
    const result = await broker.handleFrame(frame);
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/private provider|secret/);
    expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId }))
      .toEqual([expect.objectContaining({ phase: "effect_unknown", effectClass: "write" })]);
    await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "denied" });
    expect(transport.mock.calls.filter(([, request]) => request.path === "/call")).toHaveLength(1);
  });

  it("records cancellation during the response body as unknown", async () => {
    const { broker, registry, frame, checkpoints } = await setup(async () => new Response(new ReadableStream({
      start() { registry.cancelInference(binding); },
    })), args);
    await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "timeout" });
    expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
  });

  it("records the broker deadline after transport dispatch as unknown", async () => {
    const { broker, frame, checkpoints } = await setup(async (_owner, request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }), args, { timeout: true });
    await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "timeout" });
    expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
  });

  it.each([[401, "denied"], [403, "denied"], [400, "not_granted"], [404, "not_granted"], [409, "unavailable"]])
    ("retains known refusal %s as observed", async (status, code) => {
      const { broker, frame, checkpoints } = await setup(async () => json({ error: "private refusal /secret" }, Number(status)), args);
      await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code });
      expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "observed_complete" })]);
    });
});

it.each(failures)("a read with $name remains a completed safe failure", async ({ call }) => {
  const { broker, transport, frame, checkpoints } = await setup(call, READ);
  await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "unavailable" });
  expect(transport.mock.calls.filter(([, request]) => request.path === "/read-call")).toHaveLength(1);
  expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "observed_complete", effectClass: "read" })]);
});

it("refuses an undeclared send before service dispatch", async () => {
  const call = vi.fn<BotIntegrationTransport>();
  const { broker, frame, checkpoints } = await setup(call, CALLS[0]!.args, { declared: false });
  await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "denied" });
  expect(call).not.toHaveBeenCalled();
  expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "observed_complete" })]);
});

it("an already cancelled client call never enters the transport", async () => {
  const transport = vi.fn<BotIntegrationTransport>();
  const signal = AbortSignal.abort();
  await expect(createBotIntegrationClient(transport).call(OWNER, { service: "gmail", action: "send_email", label: "Work", params: {}, read: false }, signal))
    .rejects.toMatchObject({ code: "unavailable", effectUnknown: false });
  expect(transport).not.toHaveBeenCalled();
});

it("a client deadline before the broker deadline retains unknown send effect", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(ms === 25_000 ? 5 : ms));
  const { broker, frame, checkpoints } = await setup(async (_owner, request) => new Promise<Response>((_resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  }));
  await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "unavailable" });
  expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
});


it("a failed inventory before an approved send is a definite failure without service dispatch", async () => {
  const call = vi.fn<BotIntegrationTransport>();
  const { broker, frame, checkpoints, failInventory } = await setup(call);
  failInventory();
  await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "unavailable" });
  expect(call).not.toHaveBeenCalled();
  expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "observed_complete" })]);
});

it("an invalid action is a definite failure without service dispatch", async () => {
  const call = vi.fn<BotIntegrationTransport>();
  const { broker, frame, checkpoints } = await setup(call, { ...READ, action: "no_such_action" }, { grant: false });
  await expect(broker.handleFrame(frame)).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
  expect(call).not.toHaveBeenCalled();
  expect(await checkpoints.listForRun({ ownerId: OWNER, runId: binding.runId })).toEqual([expect.objectContaining({ phase: "observed_complete" })]);
});
