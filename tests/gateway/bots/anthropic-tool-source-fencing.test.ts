import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Kysely } from "kysely";
import type { BotToolRequest } from "@matrix-os/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createBotStateDatabase, OWNER, insertChat } from "./bot-state-support.js";
import { startBots } from "../../../packages/gateway/src/startup/bots.js";
import * as broker from "../../../packages/gateway/src/bots/broker-actions.js";
import * as integrationTools from "../../../packages/gateway/src/bots/integration-tools.js";
import type { BotRuntimeBinding, ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import * as dispatcher from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotWorkspace, resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createMatrixAnthropicConnectionService } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { createMatrixAnthropicSourceStore } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-source.js";
import { createNativeProviderProfileGuard } from "../../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { revokeOwnerAnthropicKey } from "../../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import { storeApiKey } from "../../../packages/gateway/src/onboarding/api-key.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import * as grants from "../../../packages/gateway/src/bots/repositories/grants.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const cleanup: Array<() => Promise<unknown>> = []; // bounded by fixture count, drained after each test
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(realIntegrations = false) {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "matrix-recipe-source-"));
  cleanup.push(async () => { await rm(home, { recursive: true, force: true }); await rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true }); });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap(); cleanup.push(() => agents.close());
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: {
    async get() { throw Object.assign(new Error("Fixture terminal absent"), { code: "session_not_found" }); }, async observeAgentLiveness() { return "stopped"; },
  } });
  const service = createMatrixAnthropicConnectionService({ homePath: home, ownerId: OWNER,
    sourceStore: createMatrixAnthropicSourceStore({ homePath: home, profileGuard: guard }), supports: { rootChat: true, recipeBots: true },
    fetch: vi.fn(async () => Response.json({ data: [{ type: "model", id: "claude-synthetic", display_name: "Synthetic Claude", max_input_tokens: 200000, max_tokens: 8192 }], has_more: false, last_id: "claude-synthetic" })),
  }); cleanup.push(() => service.shutdown());
  const connected = await service.connect(OWNER, { apiKey: "sk-ant-source-synthetic", expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "connect-source" });
  const call = vi.fn(async () => ({ ok: true as const, content: [{ type: "text" as const, text: "integration result" }] }));
  if (!realIntegrations) vi.spyOn(integrationTools, "createBotIntegrationTools").mockReturnValue({ inventory: call, call } as never);
  let inventoryWait: Promise<void> | undefined;
  const transport = vi.fn(async (_owner: string, request: { method: string; path: string }) => {
    if (request.method === "GET") { await inventoryWait; return Response.json([{ id: "conn_fixture", service: "gmail", account_label: "Fixture", status: "active" }]); }
    return Response.json({ data: { fixture: true } });
  });
  const captured = vi.spyOn(broker, "createBotBrokerActions");
  const dispatcherFactory = vi.spyOn(dispatcher, "createBotToolDispatcher");
  const services = await startBots({ homePath: home, repository, agents, matrixAnthropic: service,
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    integrations: transport,
    host: { available: true, client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() }, registerAuthorizer: vi.fn(() => () => {}) } as never,
  }); cleanup.push(() => services!.close());
  const botId = "bot_sourcefence"; await createBotWorkspace({ homePath: home, botId });
  const root = await resolveBotWorkspaceRoot({ homePath: home, owner: { type: "personal", ownerId: OWNER }, ref: { kind: "bot_workspace", botId } });
  const binding: BotRuntimeBinding = { runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId,
    chatId: "chat_sourcefence", taskId: "task_sourcefence", runId: "run_sourcefence", rootFingerprint: root.fingerprint,
    route: { api: "anthropic-messages", modelId: "claude-synthetic", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 },
    accessSourceId: "owner_anthropic_key", anthropicApi: { connectionRevision: connected.revision, credentialGeneration: connected.credentialGeneration! },
    capabilities: ["artifact.write", "integration.call"], requestClass: "interactive" };
  if (realIntegrations) {
    await agents.createRecipeBot({ type: "personal", ownerId: OWNER }, { id: botId, createHash: "f".repeat(64),
      fields: { name: "Fixture Bot", description: "Fixture", instructions: "Fixture", selection: { instanceId: "matrix_bot_default", model: "auto" } },
      recipeRef: { recipeId: "event-request-desk", version: "2026-09-27.1" } });
    await insertChat(db, binding.chatId); const now = new Date().toISOString();
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId, chatId: binding.chatId, now });
    binding.taskId = (await createBotTasksRepository(db).create({ ownerId: OWNER, botId, chatId: binding.chatId, now })).taskId;
    await createBotGrantsRepository(db).grant({ ownerId: OWNER, botId, service: "gmail", connectionId: "conn_fixture", accountLabel: "Fixture",
      effects: ["read", "write"], audience: "direct", grantedByActorId: OWNER, now });
  }
  return { home, root: root.primaryWorkspaceRoot, call, service, binding, transport, db, services,
    dispatcherOptions: dispatcherFactory.mock.calls[0]![0],
    holdInventory(wait: Promise<void>) { inventoryWait = wait; }, tools: captured.mock.calls[0]![0].tools };
}
const artifact: BotToolRequest = { toolCallId: "call_artifact", capability: "artifact.write", args: { relPath: "result.txt", content: "source fenced", mimeType: "text/plain" } };
const integration: BotToolRequest = { toolCallId: "call_integration", capability: "integration.call", args: { service: "gmail", action: "send_email", connectionId: "conn_fixture", params: {} } };
it("keeps a current recipe source usable for artifact and Integration dispatch", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await f.tools.prepare!(f.binding, artifact, signal); await f.tools.dispatch(f.binding, artifact, signal);
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("source fenced");
  await f.tools.prepare!(f.binding, integration, signal); await f.tools.dispatch(f.binding, integration, signal);
  expect(f.call).toHaveBeenCalledTimes(1);
});
it.each(["removal", "replacement"])("fences preparation and dispatch after native key %s without needing an aborted run signal", async mutation => {
  const f = await fixture(), signal = new AbortController().signal;
  await f.tools.prepare!(f.binding, artifact, signal); await f.tools.prepare!(f.binding, integration, signal);
  if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  expect(signal.aborted).toBe(false);
  for (const request of [artifact, integration]) {
    await expect(f.tools.prepare!(f.binding, request, signal)).rejects.toMatchObject({ code: "stale_generation" });
    await expect(f.tools.dispatch(f.binding, request, signal)).rejects.toMatchObject({ code: "stale_generation" });
  }
  await expect(readFile(join(f.root, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.call).not.toHaveBeenCalled();
});

it.each(["removal", "replacement"])("blocks artifact publication after native key %s while staged bytes are being written", async mutation => {
  const f = await fixture(), signal = new AbortController().signal;
  await writeFile(join(f.root, "result.txt"), "owner original");
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await actual.open(...args);
    if (String(args[0]).includes("/.bot-save/") && String(args[0]).endsWith(".tmp")) {
      const original = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...writeArgs) => { await original(...writeArgs); entered(); await hold; });
    }
    return file;
  });
  const pending = f.tools.dispatch(f.binding, artifact, signal);
  await started;
  try {
    if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
  expect(signal.aborted).toBe(false); expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("owner original");
  expect(await readdir(join(f.root, ".bot-save"))).toEqual([]);
});

it.each(["removal", "replacement"])("blocks the real Integration call after native key %s during inventory preparation", async mutation => {
  const f = await fixture(true), signal = new AbortController().signal;
  const request: BotToolRequest = { toolCallId: "call_inventory_gap", capability: "integration.call", args: { service: "gmail", action: "list_threads", connectionId: "conn_fixture", params: {} } };
  let release!: () => void;
  f.holdInventory(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.tools.dispatch(f.binding, request, signal);
  await vi.waitFor(() => expect(f.transport).toHaveBeenCalledWith(OWNER, expect.objectContaining({ method: "GET" })));
  try {
    if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
  expect(signal.aborted).toBe(false); expect(f.transport.mock.calls.filter(([, request]) => request.method === "POST")).toEqual([]);
});

it.each(["removal", "replacement"])("blocks the real Integration call after native key %s during the final grant lookup", async mutation => {
  const f = await fixture(true), signal = new AbortController().signal;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const original = grants.createBotGrantsRepository; let lookups = 0;
  vi.spyOn(grants, "createBotGrantsRepository").mockImplementation(db => {
    const repository = original(db);
    return { ...repository, async findUsable(...args) {
      const result = await repository.findUsable(...args);
      if (++lookups === 2) { entered(); await hold; }
      return result;
    } };
  });
  const request: BotToolRequest = { toolCallId: "call_grant_gap", capability: "integration.call", args: { service: "gmail", action: "list_threads", connectionId: "conn_fixture", params: {} } };
  const pending = f.tools.dispatch(f.binding, request, signal);
  await started;
  try {
    if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
  expect(signal.aborted).toBe(false); expect(f.transport.mock.calls.filter(([, request]) => request.method === "POST")).toEqual([]);
});

it("allows a current source through real recipe grants and Integration transport", async () => {
  const f = await fixture(true);
  const request: BotToolRequest = { toolCallId: "call_current_real", capability: "integration.call", args: { service: "gmail", action: "list_threads", connectionId: "conn_fixture", params: {} } };
  await expect(f.tools.dispatch(f.binding, request, new AbortController().signal)).resolves.toMatchObject({ result: { ok: true } });
  expect(f.transport).toHaveBeenCalledWith(OWNER, expect.objectContaining({ method: "POST", path: "/read-call" }));
});

function ordinaryBinding(binding: BotRuntimeBinding): ManagedPiRuntimeBinding {
  const { botId, taskId, ...source } = binding;
  void botId;
  void taskId;
  return { ...source, kind: "managed_chat", workspace: { kind: "chat_workspace" } };
}
it.each(["removal", "replacement"])("blocks ordinary Anthropic Chat publication after key %s during the final workspace read", async mutation => {
  const f = await fixture(), signal = new AbortController().signal, binding = ordinaryBinding(f.binding);
  let release!: () => void, entered!: () => void, reads = 0;
  const hold = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const managedWorkspace = vi.fn(async (captured: ManagedPiRuntimeBinding) => {
    expect(await f.service.revalidate(captured, signal)).toBe(true);
    if (++reads === 2) { entered(); await hold; }
    return f.root;
  });
  // Retain the actual source callback registered by startBots. Only the
  // asynchronous workspace read is held, after its own source check succeeded.
  const tools = dispatcher.createBotToolDispatcher({ ...f.dispatcherOptions, managedWorkspace });
  const pending = tools.dispatch(binding, artifact, signal);
  await started;
  try {
    if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-replacement-synthetic");
  } finally { release(); }
  await expect(pending).rejects.toMatchObject({ code: "stale_generation" });
  expect(signal.aborted).toBe(false); expect(managedWorkspace).toHaveBeenCalledTimes(2);
  await expect(readFile(join(f.root, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(f.home, dispatcher.MANAGED_SAVE_STAGING))).toEqual([]);
});
it.each(["anthropic", "funded", "chatgpt"])("preserves ordinary %s Chat artifact publication with the actual registered source callback", async source => {
  const f = await fixture(), binding = ordinaryBinding(f.binding);
  if (source !== "anthropic") {
    delete binding.anthropicApi;
    binding.accessSourceId = source === "funded" ? "matrix_included" : "matrix_chatgpt_plan";
    if (source === "chatgpt") {
      binding.route = { ...binding.route, api: "openai-responses", modelId: "gpt-account-model" };
      binding.subscription = { accountId: "fixture-account", peerId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2", computerId: "fixture-computer", grantRevision: 1 };
    }
    await revokeOwnerAnthropicKey(f.home);
  }
  const tools = dispatcher.createBotToolDispatcher({ ...f.dispatcherOptions, managedWorkspace: async () => f.root });
  await expect(tools.dispatch(binding, artifact, new AbortController().signal)).resolves.toMatchObject({ result: { ok: true } });
  expect(await readFile(join(f.root, "result.txt"), "utf8")).toBe("source fenced");
  expect(await readdir(join(f.home, dispatcher.MANAGED_SAVE_STAGING))).toEqual([]);
});
