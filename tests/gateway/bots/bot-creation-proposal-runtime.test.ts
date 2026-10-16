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
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import type { BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";

it("carries an actual admitted draft tool through runtime, canonical persistence and owner-scoped wire readback", async () => {
  // Deterministic tool fixture exercises the production bridge; it is not model/live acceptance.
  const { db, destroy } = await createBotStateDatabase();
  const home = await mkdtemp(join(tmpdir(), "bot-creation-proposal-"));
  const lifetime = new AbortController(); const registry = new BotRuntimeRegistry();
  const providerSnapshot = makeAiProviderSnapshot();
  const createRuntime = vi.fn(async (input: unknown) => { void input; return { runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", state: "running" }; });
  const host = { available: true, client: { createRuntime, stopRuntime: vi.fn(async () => undefined), runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { runId: string } }) => {
    const binding = registry.lookupRun({ ...request, runId: request.command.runId });
    if (!binding || !("kind" in binding)) throw new Error("Missing managed binding");
    const spec = await runtime.runs.loadRunSpec(binding);
    expect(spec.capabilities).toEqual(["bot.creation.propose"]);
    expect(spec.systemPrompt).toContain("configure a Bot creation draft");
    expect(spec.turn).toMatchObject({ text: expect.stringContaining("creation_runtime") });
    const tools = createBotTools({ capabilities: spec.capabilities, broker: { tool: input => ownerTools.dispatch(binding, input, lifetime.signal) } as unknown as BotBrokerClient, state: { waitingForPerson: false, effectUnknown: false } });
    expect(tools.map(tool => tool.name)).toEqual(["propose_bot_draft"]);
    await tools[0]!.execute("model_tool_fixture", { patch: { name: "Planner", instructions: "Help plan the day." } }, lifetime.signal);
    await vi.waitFor(async () => expect((await repository.getDetailPage({ type: "personal", ownerId: OWNER }, binding.chatId, { limit: 100 }))!.activities.some(activity => activity.type === "bot.draft.proposed")).toBe(true), { timeout: 5000 });
    const persisted = (await repository.getDetailPage({ type: "personal", ownerId: OWNER }, binding.chatId, { limit: 100 }))!.activities.find(activity => activity.type === "bot.draft.proposed")!;
    await expect(repository.appendRunActivities({ type: "personal", ownerId: OWNER }, binding.chatId, binding.runId,
      [{ ...persisted, id: "activity_second", proposalId: "proposal_second" } as typeof persisted])).rejects.toThrow();
    expect(await repository.appendRunActivities({ type: "personal", ownerId: OWNER }, binding.chatId, binding.runId, [persisted])).toBe(0);
    return { ok: true, reply: { runId: binding.runId, status: "completed", toolActions: 1, sessionRevision: 1 } };
  } } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, roots: { resolve: vi.fn() } });
  const ownerTools = createManagedPiOwnerTools({ authority: admission.toolAuthority, signalFor: binding => registry.inferenceSignal(binding) });
  const runtime = createManagedPiRuntime({ admission, ownerTools, host, providers: { getSnapshot: async () => providerSnapshot }, lifetime: lifetime.signal, forgetRun: () => undefined, cancelInference: binding => registry.cancelInference(binding) });
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agentContext = new ChatAgentContext({ repository, agents: { get: vi.fn() }, botChats: { directBot: async (owner, chatId) => (await createBotBindingsRepository(db).forChat({ ownerId: owner.ownerId, chatId }))[0]?.botId ?? null }, enabled: () => true });
  const catalog = { getCatalog: async () => ({ revision: "creation_test", drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }], instances: managedPiChatInstances(providerSnapshot).map(instance => ({ ...instance, catalogRevision: "creation_test" })) }) };
  const orchestrator = new CanonicalChatOrchestrator({ repository, agentContext, catalog, adapters: new CanonicalChatProviderRegistry([runtime.adapter]) });
  const owner = { type: "personal" as const, ownerId: OWNER };
  try {
    await repository.create(owner, { id: "chat_creation_runtime", clientRequestId: "req_creation_chat", title: "Create Bot" });
    const botCreation = BotCreationSnapshotSchema.parse({ sessionId: "creation_runtime", draftRevision: 7, seed: { kind: "scratch" }, draft: { name: "", description: "", instructions: "", selection: null } });
    const accepted = await orchestrator.admitTurn({ userId: OWNER, source: "jwt" }, owner, "chat_creation_runtime", { clientRequestId: "req_creation_turn", baseRevision: 0, parts: [{ type: "text", text: "Create a daily planner draft" }], selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised", botCreation });
    expect(accepted.run.context?.botCreation).toEqual(botCreation);
    await vi.waitFor(async () => expect((await repository.get(owner, accepted.run.chatId))?.activeRun).toBeUndefined(), { timeout: 10_000 });
    const detail = await repository.getDetailPage(owner, accepted.run.chatId, { limit: 100 });
    expect(detail!.runs[0]?.status).toBe("completed");
    expect(detail!.activities.filter(activity => activity.type === "bot.draft.proposed")).toEqual([expect.objectContaining({ sessionId: "creation_runtime", baseDraftRevision: 7, patch: { name: "Planner", instructions: "Help plan the day." } })]);
    CanonicalChatDetailResponseSchema.parse(projectChatBotCreationResponse(detail, "1"));
    const legacy = projectChatBotCreationResponse(detail, "0");
    expect(legacy!.activities.some(activity => activity.type === "bot.draft.proposed")).toBe(false);
    expect(legacy!.runs[0]?.context).not.toHaveProperty("botCreation");
    expect(await repository.getDetailPage({ type: "personal", ownerId: "other_owner" }, accepted.run.chatId, { limit: 100 })).toBeNull();
    expect(await db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual([]);
    expect(createRuntime.mock.calls[0]?.[0]).toMatchObject({ sandbox: { worktree: { mode: "ro" } } });
  } finally {
    await orchestrator.close(); await runtime.close(); lifetime.abort(); registry.shutdown(); await destroy(); await rm(home, { recursive: true, force: true });
  }
}, 20_000);
