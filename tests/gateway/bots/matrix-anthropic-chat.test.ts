import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";
import { createNativeProviderProfileGuard } from "../../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { createMatrixAnthropicSourceStore } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-source.js";
import { createMatrixAnthropicConnectionService } from "../../../packages/gateway/src/ai-providers/matrix-anthropic-connection.js";
import { revokeOwnerAnthropicKey } from "../../../packages/gateway/src/ai-providers/owner-anthropic-key.js";
import * as workspaces from "../../../packages/gateway/src/chat/managed-pi-workspace.js";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { createManagedPiMcpClient } from "../../../packages/gateway/src/chat/managed-pi-mcp-client.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../../../packages/gateway/src/bots/integration-client.js";
import { getService } from "../../../packages/gateway/src/integrations/registry.js";
import type { BotToolRequest } from "@matrix-os/contracts";
import { storeApiKey } from "../../../packages/gateway/src/onboarding/api-key.js";
import { withMatrixAnthropicProviderInstances } from "../../../packages/gateway/src/bots/matrix-anthropic-provider-instance.js";
import { AiProviderService } from "../../../packages/gateway/src/ai-providers/service.js";
import { BotRuntimeRegistry, type ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import * as persistence from "../../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import * as boundedJson from "../../../packages/gateway/src/bounded-json-file.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(permissionMode: "supervised" | "full_access" = "supervised") {
 const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
 const home = await mkdtemp(join(tmpdir(), "matrix-api-chat-")); cleanup.push(async () => { await rm(home, { force: true, recursive: true }); await rm(join(dirname(home), ".matrix-private", basename(home)), { force: true, recursive: true }); });
 const guard = createNativeProviderProfileGuard({ homePath: home, registry: { async get() { throw Object.assign(new Error("Fixture terminal absent"), { code: "session_not_found" }); }, async observeAgentLiveness() { return "stopped"; } } });
 const registry = new BotRuntimeRegistry(); cleanup.push(async () => registry.shutdown());
 const discovery = vi.fn<typeof fetch>(async () => Response.json({ data: [{ type: "model", id: "claude-synthetic-model", display_name: "Synthetic Claude", max_input_tokens: 200000, max_tokens: 8192 }], has_more: false, last_id: "claude-synthetic-model" }));
 const service = createMatrixAnthropicConnectionService({ ownerId: OWNER, homePath: home, sourceStore: createMatrixAnthropicSourceStore({ homePath: home, profileGuard: guard }), supports: { rootChat: true, recipeBots: true }, fetch: discovery, onSourceChanged: () => registry.cancelAnthropicInference() }); cleanup.push(() => service.shutdown());
 const connected = await service.connect(OWNER, { apiKey: "sk-ant-synthetic-owner", expectedRevision: 0, expectedCredentialGeneration: null, idempotencyKey: "connect-api" });
 const canonicalProviders = new AiProviderService({ homePath: home, env: {}, matrixAnthropicConnection: () => service.observe(OWNER) });
 cleanup.push(async () => canonicalProviders.close());
 const catalog = withMatrixAnthropicProviderInstances({ getCatalog: async () => ({ revision: "fixture", drivers: [], instances: [] }) }, canonicalProviders, () => true, OWNER);
 const selection = (await catalog.getCatalog({ userId: OWNER, source: "jwt" })).instances.find(i => i.id === "matrix_pi_anthropic_api")!.defaultSelection!;
 const createRuntime = vi.fn(async () => ({ runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", state: "running" }));
 let binding: ManagedPiRuntimeBinding | undefined, finish = () => {};
 const hold = new Promise<void>(resolve => { finish = resolve; });
 const runBot = vi.fn(async (input: { runId?: string; runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => { binding = registry.lookupRun({ ...input, runId: input.command.runId }) as ManagedPiRuntimeBinding; await hold; return { ok: true, reply: { runId: input.command.runId, status: "completed", toolActions: 0, sessionRevision: 1 } }; });
 const host = { available: true, client: { createRuntime, runBot, stopRuntime: vi.fn(async () => { finish(); }) } } as unknown as ScopeRuntimeHost;
 const providers = { getSnapshot: vi.fn(async () => { throw new Error("Funded fallback forbidden"); }) };
 const admission = createManagedPiAdmission({ homePath: home, db, host, registry, matrixAnthropic: service, toolCapabilities: ["integration.call", "mcp.call"], roots: { resolve: async () => { throw new Error("Unselected project forbidden"); } } });
 const runtime = createManagedPiRuntime({ admission, host, providers, matrixAnthropic: service, lifetime: new AbortController().signal, forgetRun: () => {}, cancelInference: b => registry.cancelInference(b) });
 const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>), orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
 cleanup.push(async () => { finish(); await orchestrator.drain(); await runtime.close(); await orchestrator.close(); });
 const owner = { type: "personal" as const, ownerId: OWNER };
 await repository.create(owner, { id: "chat_api", clientRequestId: "req_api", title: "API source" });
 const result = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_api", { clientRequestId: "req_api_turn", baseRevision: 0, selection, interactionMode: "default", permissionMode, parts: [{ type: "text", text: "Hello" }] });
 await vi.waitFor(() => expect(binding).toBeDefined());
 const inference = vi.fn<typeof fetch>(async () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
 const fallback = vi.fn(async () => { throw new Error("Ambient credential fallback forbidden"); });
 const forward = () => forwardBotInference({ version: 1, requestId: randomUUID(), runtimeHandle: binding!.runtimeHandle, executionGeneration: binding!.executionGeneration, action: "inference.messages", method: "POST", path: "/v1/messages", headers: { "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: selection.model, stream: true, messages: [] }) }, binding!, modelId => registry.authorize({ ...binding!, modelId, action: "inference.messages" }), { homePath: home, matrixAnthropic: service, lifetime: new AbortController().signal, runSignal: registry.inferenceSignal(binding!)!, fetchImpl: inference, resolveCredentials: fallback, revalidateBinding: async b => { try { await admission.toolAuthority(b as ManagedPiRuntimeBinding); return true; } catch (error) { if (error instanceof Error) return false; throw error; } } });
 return { home, db, service, connected, selection, binding: binding!, admission, result, inference, fallback, providers, registry, forward, createRuntime, finish };
}
it("preserves API billing through persisted canonical admission and two inference frames, then fences Disconnect", async () => {
 const f = await fixture(); expect(f.result.run.selection).toEqual(f.selection);
 expect(f.binding.anthropicApi?.credentialGeneration).toBe(f.connected.credentialGeneration);
 expect(f.binding.accessSourceId).toBe("owner_anthropic_key");
 expect((await f.forward()).ok).toBe(true); expect((await f.forward()).ok).toBe(true);
 expect(f.inference).toHaveBeenCalledTimes(2); expect(f.fallback).not.toHaveBeenCalled(); expect(f.providers.getSnapshot).not.toHaveBeenCalled();
 expect(new Headers(f.inference.mock.calls[0]![1]!.headers).get("x-api-key")).toBe("sk-ant-synthetic-owner");
 await f.service.disconnect(OWNER, { expectedRevision: f.connected.revision, expectedCredentialGeneration: f.connected.credentialGeneration, idempotencyKey: "disconnect-api" });
 expect(f.registry.inferenceSignal(f.binding)?.aborted).toBe(true);
 expect((await f.forward()).ok).toBe(false); await expect(f.admission.toolAuthority(f.binding)).rejects.toThrow(); expect(f.inference).toHaveBeenCalledTimes(2);
 f.finish();
});
it("refuses persisted selection changes and canonical native key replacement before later paid frames", async () => {
 const f = await fixture();
 await f.db.updateTable("chat_runs").set({ selection: { ...f.selection, options: [{ id: "connectionRevision", value: "9" }, f.selection.options![1]!] } }).where("id", "=", f.binding.runId).execute();
 expect((await f.forward()).ok).toBe(false); expect(f.inference).not.toHaveBeenCalled();
 await f.db.updateTable("chat_runs").set({ selection: f.selection }).where("id", "=", f.binding.runId).execute();
 await storeApiKey(f.home, "sk-ant-synthetic-replacement");
 expect((await f.forward()).ok).toBe(false); expect(f.inference).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
 const before = f.createRuntime.mock.calls.length;
 await expect(f.admission.admit({ ownerId: OWNER, chatId: f.binding.chatId, runId: f.binding.runId, resolved: f.binding })).rejects.toThrow(); expect(f.createRuntime).toHaveBeenCalledTimes(before);
 f.finish();
});

it("blocks later paid frames, new runtimes and existing tool authority after uncertain Disconnect despite readable prior state", async () => {
 const f = await fixture(), path = join(f.home, "system/ai-providers/matrix-anthropic-source.json");
 expect((await f.forward()).ok).toBe(true);
 const write = persistence.writeProviderJsonAtomic, read = boundedJson.readBoundedJsonFileWithIdentity;
 let proofUnavailable = false;
 vi.spyOn(persistence, "writeProviderJsonAtomic").mockImplementation(async (target, value) => {
  if (target === path) { proofUnavailable = true; throw new Error("synthetic publication failure"); }
  return write(target, value);
 });
 vi.spyOn(boundedJson, "readBoundedJsonFileWithIdentity").mockImplementation(async (target, limit) => {
  if (target === path && proofUnavailable) { proofUnavailable = false; throw new Error("synthetic transient proof failure"); }
  return read(target, limit);
 });
 await expect(f.service.disconnect(OWNER, { expectedRevision: f.connected.revision, expectedCredentialGeneration: f.connected.credentialGeneration, idempotencyKey: "uncertain-disable-api" })).rejects.toThrow();
 vi.restoreAllMocks();
 expect(f.registry.inferenceSignal(f.binding)?.aborted).toBe(true);
 expect((await f.forward()).ok).toBe(false); expect(f.inference).toHaveBeenCalledTimes(1);
 await expect(f.admission.toolAuthority(f.binding)).rejects.toThrow();
 const before = f.createRuntime.mock.calls.length;
 await expect(f.admission.admit({ ownerId: OWNER, chatId: f.binding.chatId, runId: f.binding.runId, resolved: f.binding })).rejects.toThrow();
 expect(f.createRuntime).toHaveBeenCalledTimes(before); expect(f.fallback).not.toHaveBeenCalled(); expect(f.providers.getSnapshot).not.toHaveBeenCalled();
 f.finish();
});

/** Hold a real completed filesystem read, after the earlier source check. */
function holdWorkspaceRead(checkpoint: number) {
 const original = workspaces.managedPiWorkspace;
 let entered!: () => void, release!: () => void, reads = 0;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const held = new Promise<void>(resolve => { release = resolve; });
 vi.spyOn(workspaces, "managedPiWorkspace").mockImplementation(async (...args) => {
  const root = await original(...args);
  if (++reads === checkpoint) { entered(); await held; }
  return root;
 });
 return { started, release };
}
async function externalTools(f: Awaited<ReturnType<typeof fixture>>) {
 const integrationTransport = vi.fn<BotIntegrationTransport>(async (_owner, request) => {
  if (request.path === "/agent-catalog") return Response.json([{ id: "github", actions: getService("github")!.actions }]);
  if (request.method === "GET") return Response.json([{ id: "conn_fixture", service: "github", account_label: "Fixture", status: "active" }]);
  return Response.json({ data: { fixture: true } });
 });
 const mcpTransport = vi.fn<typeof fetch>(async () => Response.json({ content: [{ type: "text", text: "Fixture" }] }));
 const tools = createManagedPiOwnerTools({ authority: f.admission.toolAuthority, signalFor: b => f.registry.inferenceSignal(b),
  integrations: createBotIntegrationClient(integrationTransport),
  mcp: createManagedPiMcpClient({ platformUrl: "https://platform.invalid", handle: "synthetic", token: "synthetic-token", ownerId: OWNER, fetcher: mcpTransport }),
  approvals: { registerRun: async () => ({ generation: 1 }), prepare: async () => ({ kind: "allow" }), decide: async () => ({}), revokeRun: async () => true, clearRunApprovals: async () => ({ generation: 2, invalidated: 0 }) } });
 await tools.open(f.binding, () => {}); cleanup.push(() => tools.closeRun(f.binding.runId));
 return { tools, integrationTransport, mcpTransport };
}
const externalRequest = (kind: "integration" | "mcp"): BotToolRequest => kind === "integration"
 ? { toolCallId: "late_integration", capability: "integration.call", args: { service: "github", connectionId: "conn_fixture", action: "list_issues", params: { repo: "synthetic/fixture", per_page: 1 } } }
 : { toolCallId: "late_mcp", capability: "mcp.call", args: { serverId: "123e4567-e89b-42d3-a456-426614174000", tool: "synthetic_echo", arguments: {} } };
it.each(["removal", "replacement"] as const)("blocks captured Anthropic inference after native key %s during its final workspace read", async mutation => {
 const f = await fixture(), signal = f.registry.inferenceSignal(f.binding)!;
 const wait = holdWorkspaceRead(2), pending = f.forward();
 await wait.started;
 try {
  expect(f.inference).not.toHaveBeenCalled();
  if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-synthetic-late-replacement");
  expect(signal.aborted).toBe(false);
 } finally { wait.release(); }
 expect((await pending).ok).toBe(false); expect(f.inference).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
});
it.each([
 ["integration", "removal"], ["integration", "replacement"], ["mcp", "removal"], ["mcp", "replacement"],
] as const)("blocks actual managed %s transport after native key %s during the final tool workspace read", async (kind, mutation) => {
  const f = await fixture("full_access"), { tools, integrationTransport, mcpTransport } = await externalTools(f);
  const request = externalRequest(kind), signal = f.registry.inferenceSignal(f.binding)!;
  await tools.prepare(f.binding, request, signal);
  const wait = holdWorkspaceRead(kind === "integration" ? 3 : 2);
  const pending = tools.dispatch(f.binding, request, signal);
  const refused = expect(pending).rejects.toThrow();
  await wait.started;
  try {
   if (mutation === "removal") await revokeOwnerAnthropicKey(f.home); else await storeApiKey(f.home, "sk-ant-synthetic-late-replacement");
   expect(signal.aborted).toBe(false);
  } finally { wait.release(); }
  await refused;
  expect(integrationTransport.mock.calls.filter(([, request]) => request.method === "POST")).toEqual([]);
  expect(mcpTransport).not.toHaveBeenCalled();
});
it("preserves actual managed Integration and MCP calls with a current API source", async () => {
 const f = await fixture("full_access"), { tools, integrationTransport, mcpTransport } = await externalTools(f);
 for (const kind of ["integration", "mcp"] as const) await expect(tools.dispatch(f.binding, externalRequest(kind), f.registry.inferenceSignal(f.binding)!)).resolves.toMatchObject({ ok: true });
 expect(integrationTransport.mock.calls.filter(([, request]) => request.method === "POST")).toHaveLength(1);
 expect(mcpTransport).toHaveBeenCalledTimes(1);
});
it("refuses ordinary workspace authority when the run signal aborts during the final filesystem read", async () => {
 const f = await fixture(), wait = holdWorkspaceRead(1), pending = f.admission.toolAuthority(f.binding);
 const refused = expect(pending).rejects.toThrow();
 await wait.started;
 try { f.registry.cancelInference(f.binding); } finally { wait.release(); }
 await refused; expect(f.inference).not.toHaveBeenCalled();
});
