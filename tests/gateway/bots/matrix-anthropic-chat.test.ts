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
async function fixture() {
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
 const admission = createManagedPiAdmission({ homePath: home, db, host, registry, matrixAnthropic: service, roots: { resolve: async () => { throw new Error("Unselected project forbidden"); } } });
 const runtime = createManagedPiRuntime({ admission, host, providers, matrixAnthropic: service, lifetime: new AbortController().signal, forgetRun: () => {}, cancelInference: b => registry.cancelInference(b) });
 const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>), orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
 cleanup.push(async () => { finish(); await orchestrator.drain(); await runtime.close(); await orchestrator.close(); });
 const owner = { type: "personal" as const, ownerId: OWNER };
 await repository.create(owner, { id: "chat_api", clientRequestId: "req_api", title: "API source" });
 const result = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_api", { clientRequestId: "req_api_turn", baseRevision: 0, selection, interactionMode: "default", permissionMode: "supervised", parts: [{ type: "text", text: "Hello" }] });
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
