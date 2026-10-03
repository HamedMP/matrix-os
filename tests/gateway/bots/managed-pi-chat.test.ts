import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { BotBrokerError, type BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { getService } from "../../../packages/gateway/src/integrations/registry.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { managedPiWorkspace } from "../../../packages/gateway/src/chat/managed-pi-workspace.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { contextPrompt } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatRunContext } from "@matrix-os/contracts";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const GLM = "@cf/zai-org/glm-5.3-flash";

it("passes the already prepared canonical Agent prompt to Pi exactly once", async () => {
  const snapshot = makeAiProviderSnapshot();
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const context: ChatRunContext = { version: 1, requestHash: "a".repeat(64), chats: [],
    agent: { id: "bot_0123456789abcdef", revision: 1, name: "Editor", instructions: "Keep my wording concise." } };
  // CanonicalChatOrchestrator owns context formatting before calling adapters.
  const prompt = contextPrompt("Revise this sentence.", context);
  const resolved = resolveManagedPiRoute(snapshot, selection);
  const binding: ManagedPiRuntimeBinding = { kind: "managed_chat", ownerId: OWNER, chatId: "chat_prompt",
    runId: "run_prompt", runtimeHandle: `runtime_${"f".repeat(32)}`, executionGeneration: "1",
    workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64), ...resolved,
    capabilities: ["artifact.read"], requestClass: "interactive" };
  const release = vi.fn(async () => undefined);
  const host = { client: { runBot: async () => {
    const spec = await runtime.runs.loadRunSpec(binding);
    expect(spec.turn).toEqual({ kind: "prompt", text: prompt });
    return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
  } } } as unknown as ScopeRuntimeHost;
  const runtime: ReturnType<typeof createManagedPiRuntime> = createManagedPiRuntime({ admission: { admit: async () => binding, toolAuthority: async () => ({ permissionMode: "supervised" }), release, workspace: async () => "/owned/chat" },
    host, providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal, forgetRun: () => undefined, cancelInference: () => undefined });
  const events = [];
  for await (const event of runtime.adapter.start({ owner: { type: "personal", ownerId: OWNER }, chatId: binding.chatId,
    turnId: "cturn_prompt", runId: binding.runId, prompt, context, parts: [{ type: "text", text: "Revise this sentence." }],
    selection, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  expect(release).toHaveBeenCalledExactlyOnceWith(binding.runtimeHandle);
});

it("runs an ordinary canonical Matrix Chat through the pinned Pi loop, brokered artifact tools and isolated resumed transcript", async () => {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "managed-pi-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const snapshot = makeAiProviderSnapshot();
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "matrix_cloudflare", eligibleModelIds: [GLM], vendor: "cloudflare" });
  snapshot.models.push({ ...snapshot.models[0]!, id: GLM, vendor: "cloudflare", capabilities: ["tools"], eligibleAccessSourceIds: ["matrix_cloudflare"] });
  const providers = { getSnapshot: async () => snapshot };
  const registry = new BotRuntimeRegistry();
  const handle = fauxProvider({ models: [{ id: GLM, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  handle.setResponses([
    fauxAssistantMessage(fauxToolCall("write_artifact", { path: "proof.txt", content: "PI_MANAGED_PROOF", mimeType: "text/plain" }, { id: "call_write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("Saved the file.")),
    fauxAssistantMessage(fauxToolCall("read_artifact", { path: "proof.txt" }, { id: "call_read" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("PI_MANAGED_PROOF")),
  ]);
  const specs: unknown[] = []; let serial = 0;
  const createRuntime = vi.fn(async () => ({ runtimeHandle: `runtime_${(++serial).toString(16).padStart(32, "0")}`, executionGeneration: "1" }));
  const stopRuntime = vi.fn(async () => undefined);
  const host = { available: true, client: { createRuntime, stopRuntime, runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
    const call = async (body: Record<string, unknown>) => {
      const reply = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration, runId: request.command.runId, ...body });
      if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never);
      return reply.result;
    };
    const spec = await call({ action: "bot.run.load" }) as Parameters<typeof runBotTurn>[0]["command"];
    specs.push(spec);
    const broker: BotBrokerClient = {
      loadSession: () => call({ action: "bot.session.load" }) as never,
      saveSession: (session) => call({ action: "bot.session.save", session }) as never,
      event: async (event) => { await call({ action: "bot.event", event }); },
      tool: (tool) => call({ action: "bot.tool", tool }) as never,
    };
    const reply = await runBotTurn({ command: { ...spec, version: 1, kind: "bot.run", runId: request.command.runId }, broker,
      bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() } });
    return { ok: true, reply };
  } } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, roots: { resolve: async () => { throw new Error("No project" ); } } });
  const lifetime = new AbortController();
  const runtime = createManagedPiRuntime({ admission, host, providers, lifetime: lifetime.signal,
    forgetRun: (runId) => actions.forgetRun(runId), cancelInference: (binding) => registry.cancelInference(binding) });
  const actions: ReturnType<typeof createBotBrokerActions> = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db),
    runs: runtime.runs, events: runtime.events, tools: createBotToolDispatcher({ homePath: home, managedWorkspace: admission.workspace }),
    inference: { homePath: home, lifetime: lifetime.signal } });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const catalog = { getCatalog: async () => ({ revision: "managed_test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
    instances: managedPiChatInstances(snapshot).map((instance) => ({ ...instance, catalogRevision: "managed_test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
  cleanup.push(async () => { await orchestrator.close(); await runtime.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER }; const principal = { userId: OWNER, source: "jwt" as const };
  const chat = await repository.create(owner, { id: "chat_managedchat", clientRequestId: "req_managedchat", title: "Matrix Chat" });
  const selection = { instanceId: "matrix_pi_default", model: GLM };
  for (const [index, text] of ["Save the proof.", "Read the saved file."].entries()) {
    const current = await repository.get(owner, chat.chat.id);
    await orchestrator.admitTurn(principal, owner, chat.chat.id, { clientRequestId: `req_managed_${index}`, baseRevision: current!.chat.revision,
      parts: [{ type: "text", text }], selection, interactionMode: "default", permissionMode: "full_access" });
    await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun).toBeUndefined(), { timeout: 5000 });
  }
  expect(specs).toHaveLength(2); expect(specs).toEqual([expect.objectContaining({ route: expect.objectContaining({ modelId: GLM, api: "openai-completions" }) }), expect.objectContaining({ route: expect.objectContaining({ modelId: GLM }) })]);
  const root = await managedPiWorkspace(home, OWNER, chat.chat.id); expect(await readFile(join(root.path, "proof.txt"), "utf8")).toBe("PI_MANAGED_PROOF");
  expect(await createManagedPiSessionsRepository(db).load({ ownerId: OWNER, chatId: chat.chat.id })).toMatchObject({ revision: 2, messages: expect.arrayContaining([expect.objectContaining({ role: "toolResult" })]) });
  expect(await db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("managed_pi_tool_checkpoints").select(["phase", "effect_class"]).execute()).toEqual([{ phase: "observed_complete", effect_class: "write" }, { phase: "observed_complete", effect_class: "read" }]);
  expect(registry.size).toBe(0); expect(stopRuntime).toHaveBeenCalledTimes(2);
});

it("executes owner integration and Custom MCP tools through actual Pi loop/broker and canonical mutation approval", async () => {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const home = await mkdtemp(join(tmpdir(), "managed-pi-")); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const snapshot = makeAiProviderSnapshot();
  snapshot.accessSources.push({ ...snapshot.accessSources[0]!, id: "matrix_cloudflare", eligibleModelIds: [GLM], vendor: "cloudflare" });
  snapshot.models.push({ ...snapshot.models[0]!, id: GLM, vendor: "cloudflare", capabilities: ["tools"], eligibleAccessSourceIds: ["matrix_cloudflare"] });
  const providers = { getSnapshot: async () => snapshot };
  const registry = new BotRuntimeRegistry();
  const handle = fauxProvider({ models: [{ id: GLM, input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  const serverId = "123e4567-e89b-42d3-a456-426614174000";
  const requests = [
    ["integration_inventory", {}], ["integration_describe", { service: "github" }],
    ["integration_call", { service: "github", connectionId: "conn_qa", action: "list_issues", params: { repo: "matrix/qa", per_page: 1 } }],
    ["mcp_inventory", {}], ["mcp_describe", { serverId }], ["mcp_call", { serverId, tool: "qa_echo", arguments: { text: "QA" } }],
    ["integration_call", { service: "github", connectionId: "conn_qa", action: "create_issue", params: { repo: "matrix/qa", title: "QA synthetic" } }],
  ] as const;
  handle.setResponses([...requests.map(([name, args], index) => fauxAssistantMessage(fauxToolCall(name, args, { id: `call_owner_${index}` }), { stopReason: "toolUse" })), fauxAssistantMessage(fauxText("OWNER_TOOLS_QA_OK"))]);
  const specs: unknown[] = []; let serial = 0;
  const createRuntime = vi.fn(async () => ({ runtimeHandle: `runtime_${(++serial).toString(16).padStart(32, "0")}`, executionGeneration: "1" }));
  const stopRuntime = vi.fn(async () => undefined);
  const host = { available: true, client: { createRuntime, stopRuntime, runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
    const call = async (body: Record<string, unknown>) => {
      const reply = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration, runId: request.command.runId, ...body });
      if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never);
      return reply.result;
    };
    const spec = await call({ action: "bot.run.load" }) as Parameters<typeof runBotTurn>[0]["command"];
    specs.push(spec);
    const broker: BotBrokerClient = {
      loadSession: () => call({ action: "bot.session.load" }) as never,
      saveSession: (session) => call({ action: "bot.session.save", session }) as never,
      event: async (event) => { await call({ action: "bot.event", event }); },
      tool: (tool) => call({ action: "bot.tool", tool }) as never,
    };
    const reply = await runBotTurn({ command: { ...spec, version: 1, kind: "bot.run", runId: request.command.runId }, broker,
      bridgeOrigin: "http://127.0.0.1:41000", route: { provider: handle.provider, model: handle.getModel() } });
    return { ok: true, reply };
  } } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, toolCapabilities: ["integration.inventory", "integration.describe", "integration.call", "mcp.inventory", "mcp.describe", "mcp.call"], roots: { resolve: async () => { throw new Error("No project" ); } } });
  const integrationCall = vi.fn(async () => ({ data: { count: 0 } }));
  const mcpCall = vi.fn(async () => ({ content: [{ type: "text", text: "MCP_QA_OK" }] }));
  const revoke = vi.fn(async () => true);
  const ownerTools = createManagedPiOwnerTools({ authority: admission.toolAuthority, signalFor: binding => registry.inferenceSignal(binding),
    integrations: { inventory: async () => [{ connectionId: "conn_qa", service: "github", label: "QA" }], call: integrationCall,
      describe: async (_owner, input) => Object.entries(getService(input.service)!.actions)
        .filter(([, action]) => !input.readOnly || action.risk === "read")
        .map(([id, action]) => ({ id, description: action.description, risk: action.risk, params: action.params })) },
    mcp: { inventory: async () => [{ id: serverId }], describe: async () => ({ id: serverId }), call: mcpCall },
    approvals: { registerRun: async () => ({ generation: 1 }), prepare: async () => ({ kind: "allow" }), decide: async () => ({}), revokeRun: revoke, clearRunApprovals: async () => ({ generation: 2, invalidated: 0 }) } });
  const approvalEvents: Array<{ type: string; approvalId?: string }> = [];
  const lifetime = new AbortController();
  const runtime = createManagedPiRuntime({ ownerTools: { ...ownerTools, open: (binding, emit) => ownerTools.open(binding, event => { approvalEvents.push(event); emit(event); }) }, admission, host, providers, lifetime: lifetime.signal,
    forgetRun: (runId) => actions.forgetRun(runId), cancelInference: (binding) => registry.cancelInference(binding) });
  const actions: ReturnType<typeof createBotBrokerActions> = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db),
    runs: runtime.runs, events: runtime.events, tools: createBotToolDispatcher({ homePath: home, managedTools: ownerTools, managedWorkspace: admission.workspace }),
    inference: { homePath: home, lifetime: lifetime.signal } });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const catalog = { getCatalog: async () => ({ revision: "managed_test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
    instances: managedPiChatInstances(snapshot).map((instance) => ({ ...instance, catalogRevision: "managed_test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
  cleanup.push(async () => { await orchestrator.close(); await runtime.close(); });
  const owner = { type: "personal" as const, ownerId: OWNER }; const principal = { userId: OWNER, source: "jwt" as const };
  const chat = await repository.create(owner, { id: "chat_managedchat", clientRequestId: "req_managedchat", title: "Matrix Chat" });
  const selection = { instanceId: "matrix_pi_default", model: GLM };
  const admitted = await orchestrator.admitTurn(principal, owner, chat.chat.id, { clientRequestId: "req_owner_tools", baseRevision: 0,
    parts: [{ type: "text", text: "Run the synthetic owner tools QA." }], selection, interactionMode: "default", permissionMode: "full_access" });
  await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun?.status).toBe("waiting_for_approval"), { timeout: 5000 });
  expect(integrationCall).toHaveBeenCalledTimes(1);
  expect(await db.selectFrom("managed_pi_tool_checkpoints").selectAll().where("tool_call_id", "=", "call_owner_6").execute()).toEqual([]);
  const approvalId = approvalEvents.find(event => event.type === "approval.requested")!.approvalId!;
  await orchestrator.submitApproval(owner, chat.chat.id, admitted.run.id, approvalId, { clientRequestId: "req_approve_qa", decision: "approve" });
  await vi.waitFor(async () => expect((await repository.get(owner, chat.chat.id))?.activeRun).toBeUndefined(), { timeout: 5000 });

  expect(specs).toHaveLength(1);
  expect(integrationCall).toHaveBeenCalledTimes(2); expect(integrationCall.mock.calls[0]?.[1]).toMatchObject({ read: true });
  expect(integrationCall.mock.calls[1]?.[1]).toMatchObject({ read: false, label: "QA", params: { repo: "matrix/qa", title: "QA synthetic" } });
  expect(mcpCall).toHaveBeenCalledWith(OWNER, expect.objectContaining({ serverId, tool: "qa_echo", runId: admitted.run.id }), expect.any(AbortSignal));
  expect(await db.selectFrom("bot_tasks").selectAll().execute()).toEqual([]);
  expect(await db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual([]);
  const checkpoints = await db.selectFrom("managed_pi_tool_checkpoints").select(["phase", "effect_class"]).execute();
  expect(checkpoints).toHaveLength(7); expect(checkpoints.every(row => row.phase === "observed_complete")).toBe(true);
  expect(checkpoints.filter(row => row.effect_class === "write")).toHaveLength(2);
  expect(registry.size).toBe(0); expect(revoke).toHaveBeenCalledExactlyOnceWith(admitted.run.id);
});
