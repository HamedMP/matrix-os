import { randomUUID } from "node:crypto";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BotCreationSnapshotSchema, projectChatBotCreationResponse, CanonicalChatDetailResponseSchema } from "@matrix-os/contracts";
import { createBotTools } from "../../../packages/bot-runtime/src/tools.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { createManagedPiOwnerTools } from "../../../packages/gateway/src/chat/managed-pi-owner-tools.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { OWNER, createBotStateDatabase, createRealBotStateDatabase } from "./bot-state-support.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { sql, type Kysely } from "kysely";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";

it.each([
  { flow: "interactive draft", intent: "reply", activity: "bot.draft.proposed", tool: "propose_bot_draft", args: { patch: { name: "Planner", instructions: "Help plan the day." } } },
  { flow: "legacy draft", intent: undefined, activity: "bot.draft.proposed", tool: "propose_bot_draft", args: { patch: { name: "Planner", instructions: "Help plan the day." } } },
  { flow: "interactive question", intent: "reply", activity: "bot.setup.question", tool: "ask_bot_setup_question", args: { question: "Which days should the brief cover?", suggestedReplies: ["Weekdays", "Every day"] } },
  { flow: "integration request", intent: "reply", activity: "bot.connection.requested", tool: "show_connection_setup", args: { resource: { kind: "integration", service: "linear" } } },
  { flow: "MCP request", intent: "reply", activity: "bot.connection.requested", tool: "show_connection_setup", args: { resource: { kind: "mcp" } } },
  { flow: "named MCP request", intent: "reply", activity: "bot.connection.requested", tool: "show_connection_setup", args: { resource: { kind: "mcp", name: "Internal Docs" } } },
] as const)("carries an admitted $flow through the runtime, canonical persistence and owner wire readback", async fixture => {
  // Deterministic tool fixture exercises the production bridge; it is not model/live acceptance.
  const { db, destroy } = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  const home = await mkdtemp(join(tmpdir(), "bot-creation-proposal-"));
  const lifetime = new AbortController(); const registry = new BotRuntimeRegistry();
  const providerSnapshot = makeAiProviderSnapshot();
  const model = fauxProvider({ models: [{ id: "claude-sonnet-5", input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  const contexts: string[] = [];
  model.setResponses([
    fauxAssistantMessage(fauxToolCall(fixture.tool, fixture.args, { id: "setup_event" }), { stopReason: "toolUse" }),
    fixture.flow === "interactive draft"
      ? fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "provider unavailable during redundant follow-up" })
      : fauxAssistantMessage(fauxText("I have the details.")),
  ].map(response => context => { contexts.push(JSON.stringify(context)); return response; }));
  let generation = 0;
  const createRuntime = vi.fn(async (input: unknown) => { void input; return { runtimeHandle: `runtime_${(++generation).toString(16).padStart(32, "0")}`, executionGeneration: "1", state: "running" }; });
  const host = { available: true, client: { createRuntime, renewRuntime: vi.fn(async () => undefined), stopRuntime: vi.fn(async () => undefined), runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { runId: string } }) => {
    const binding = registry.lookupRun({ ...request, runId: request.command.runId });
    if (!binding || !("kind" in binding)) throw new Error("Missing managed binding");
    const spec = await runtime.runs.loadRunSpec(binding);
    expect(spec.capabilities).toEqual(["bot.creation.propose"]);
    expect(spec.systemPrompt).toContain("configure a Bot creation draft");
    expect(spec.turn).toMatchObject({ text: expect.stringContaining("creation_runtime") });
    const call = async (body: Record<string, unknown>) => {
      const frame = { version: 1, requestId: randomUUID(), runtimeHandle: binding.runtimeHandle, executionGeneration: binding.executionGeneration, runId: binding.runId, ...body };
      const reply = await actions.handleFrame(frame);
      if (!reply?.ok) throw new Error("Setup bridge rejected " + body.action);
      return reply.result;
    };
    const broker: BotBrokerClient = {
      loadSession: () => call({ action: "bot.session.load" }) as never,
      saveSession: session => call({ action: "bot.session.save", session }) as never,
      event: async event => { await call({ action: "bot.event", event }); },
      tool: tool => call({ action: "bot.tool", tool }) as never,
    };
    const reply = await runBotTurn({ command: { ...spec, version: 1, kind: "bot.run", runId: binding.runId }, broker,
      bridgeOrigin: "http://127.0.0.1:41000", route: { provider: model.provider, model: model.getModel() } });
    if (reply.toolActions === 0) return { ok: true, reply };
    await vi.waitFor(async () => expect((await repository.getDetailPage({ type: "personal", ownerId: OWNER }, binding.chatId, { limit: 100 }))!.activities.some(activity => activity.type === fixture.activity)).toBe(true), { timeout: 5000 });
    const persisted = (await repository.getDetailPage({ type: "personal", ownerId: OWNER }, binding.chatId, { limit: 100 }))!.activities.find(activity => activity.type === fixture.activity)!;
    await expect(repository.appendRunActivities({ type: "personal", ownerId: OWNER }, binding.chatId, binding.runId,
      [{ ...persisted, id: "activity_second", proposalId: "proposal_second" } as typeof persisted])).rejects.toThrow();
    expect(await repository.appendRunActivities({ type: "personal", ownerId: OWNER }, binding.chatId, binding.runId, [persisted])).toBe(0);
    return { ok: true, reply };
  } } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, roots: { resolve: vi.fn() } });
  const ownerTools = createManagedPiOwnerTools({ authority: admission.toolAuthority, signalFor: binding => registry.inferenceSignal(binding) });
  const runtime = createManagedPiRuntime({ admission, ownerTools, host, providers: { getSnapshot: async () => providerSnapshot }, lifetime: lifetime.signal, forgetRun: () => undefined, cancelInference: binding => registry.cancelInference(binding) });
  const actions = createBotBrokerActions({ db, registry, sessions: createBotSessionsRepository(db), checkpoints: createBotCheckpointsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db), managedCheckpoints: createManagedPiCheckpointsRepository(db),
    runs: runtime.runs, events: runtime.events, tools: createBotToolDispatcher({ homePath: home, managedWorkspace: admission.workspace, managedTools: ownerTools }),
    inference: { homePath: home, lifetime: lifetime.signal } });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agentContext = new ChatAgentContext({ repository, agents: { get: vi.fn() }, botChats: { directBot: async (owner, chatId) => (await createBotBindingsRepository(db).forChat({ ownerId: owner.ownerId, chatId }))[0]?.botId ?? null }, enabled: () => true });
  const catalog = { getCatalog: async () => ({ revision: "creation_test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }], instances: managedPiChatInstances(providerSnapshot).map(instance => ({ ...instance, catalogRevision: "creation_test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, agentContext, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
  const owner = { type: "personal" as const, ownerId: OWNER };
  try {
    await repository.create(owner, { id: "chat_creation_runtime", clientRequestId: "req_creation_chat", title: "Create Bot" });
    const botCreation = BotCreationSnapshotSchema.parse({ sessionId: "creation_runtime", draftRevision: 7, intent: fixture.intent, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
    const accepted = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_creation_runtime", { clientRequestId: "req_creation_turn", baseRevision: 0, parts: [{ type: "text", text: "Create a daily planner draft" }], selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised", botCreation });
    expect(accepted.run.context?.botCreation).toEqual(botCreation);
    await vi.waitFor(async () => expect((await repository.get(owner, accepted.run.chatId))?.activeRun).toBeUndefined(), { timeout: 10_000 });
    const detail = await repository.getDetailPage(owner, accepted.run.chatId, { limit: 100 });
    expect(detail!.activities.filter(activity => activity.type === fixture.activity)).toEqual([expect.objectContaining({ sessionId: "creation_runtime", baseDraftRevision: 7, ...fixture.args })]);
    expect(detail!.runs[0]?.status).toBe("completed");
    expect(contexts).toHaveLength(fixture.intent && fixture.activity !== "bot.connection.requested" ? 1 : 2);
    CanonicalChatDetailResponseSchema.parse(projectChatBotCreationResponse(detail, "1"));
    const legacy = projectChatBotCreationResponse(detail, "0");
    expect(legacy!.activities.some(activity => activity.type === fixture.activity)).toBe(false);
    expect(legacy!.runs[0]?.context).not.toHaveProperty("botCreation");
    expect(await repository.getDetailPage({ type: "personal", ownerId: "other_owner" }, accepted.run.chatId, { limit: 100 })).toBeNull();
    expect(await db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual([]);
    expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ sandbox: { worktree: { mode: "ro" } } });
    // A private Pi transcript belongs to one setup conversation and seed, across all its turns.
    const nextTurn = { clientRequestId: "req_other_setup", baseRevision: detail!.record.chat.revision,
      parts: [{ type: "text" as const, text: "Start another agent." }], selection: accepted.run.selection,
      interactionMode: "default", permissionMode: "supervised" };
    for (const different of [
      { ...botCreation, sessionId: "creation_other" },
      { ...botCreation, seed: { kind: "recipe" as const, recipeId: "personal-daily-brief", version: "2026-09-27.1" } },
      undefined,
    ]) await expect(orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, accepted.run.chatId,
      { ...nextTurn, botCreation: different })).rejects.toThrow();
    expect(createRuntime).toHaveBeenCalledTimes(1);

    if (fixture.activity === "bot.setup.question") {
      const answer = "Weekdays, particularly Monday morning";
      const followup = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, accepted.run.chatId,
        { ...nextTurn, parts: [{ type: "text", text: answer }], botCreation: { ...botCreation, intent: "reply" } });
      expect(followup.run.context?.history).toBeUndefined();
      await vi.waitFor(async () => expect((await repository.get(owner, accepted.run.chatId))?.activeRun).toBeUndefined());
      expect(contexts).toHaveLength(2);
      for (const text of ["Create a daily planner draft", fixture.args.question, answer]) expect(contexts[1]).toContain(text);
      const second = await repository.getDetailPage(owner, accepted.run.chatId, { limit: 100 });
      expect(second!.runs.find(item => item.id === followup.run.id)?.status).toBe("completed");
    }

    // An archived shared scope can outlive the Chat's visible collaboration marker.
    const reusedChat = "chat_previous_shared_scope";
    await repository.create(owner, { id: reusedChat, clientRequestId: "req_shared_chat", title: "Previously shared" });
    await sql`INSERT INTO collaboration_scopes
      (id,owner_type,owner_id,kind,resource_id,membership_mode,lifecycle,revision,auth_epoch,authority_runtime_id,authority_generation,created_at,updated_at)
      VALUES ('30000000-0000-4000-8000-000000000123','personal',${OWNER},'chat',${reusedChat},'direct','archived',1,1,'vps:draft',1,now(),now())`.execute(db);
    await expect(orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, reusedChat, {
      clientRequestId: "req_shared_draft", baseRevision: 0, parts: [{ type: "text", text: "Help with an Agent draft." }],
      selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default",
      permissionMode: "supervised", botCreation,
    })).rejects.toThrow();
    expect((await repository.getDetailPage(owner, reusedChat, { limit: 100 }))?.messages).toEqual([]);

  } finally {
    await orchestrator.close(); await runtime.close(); lifetime.abort(); registry.shutdown(); await destroy(); await rm(home, { recursive: true, force: true });
  }
}, 20_000);

it("accepts the native Pi tool argument schema for responsibilities, Skills and sources", async () => {
  const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");
  const [tool] = createBotTools({
    capabilities: ["bot.creation.propose"], broker: {} as BotBrokerClient,
    state: { waitingForPerson: false, effectUnknown: false },
  });
  const args = { patch: { instructions: "Help with onboarding.", recipe: {
    skills: ["briefing"], integrations: [{ service: "calendar" }], output: "Weekly plan",
  } } };
  expect(validateToolArguments(tool!, { type: "toolCall", id: "call_draft", name: tool!.name, arguments: args })).toEqual(args);
});
