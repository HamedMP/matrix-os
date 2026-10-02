import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { BotBrokerError, type BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
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
  let runtime: ReturnType<typeof createManagedPiRuntime>;
  const host = { client: { runBot: async () => {
    const spec = await runtime.runs.loadRunSpec(binding);
    expect(spec.turn).toEqual({ kind: "prompt", text: prompt });
    return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 0, sessionRevision: 1 } };
  } } } as unknown as ScopeRuntimeHost;
  runtime = createManagedPiRuntime({ admission: { admit: async () => binding, release, workspace: async () => "/owned/chat" },
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
  let actions: ReturnType<typeof createBotBrokerActions>;
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
  actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
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
