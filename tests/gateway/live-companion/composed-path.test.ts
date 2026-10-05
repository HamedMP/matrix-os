import { EventEmitter } from "node:events";
import { CanonicalProviderCatalogSchema, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import { VoiceServerFrameSchema } from "@matrix-os/contracts/voice-session";
import { KyselyPGlite } from "kysely-pglite";
import { expect, it, vi } from "vitest";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatVoiceDeliveryRepository } from "../../../packages/gateway/src/chat/voice-delivery-repository.js";
import { createCanonicalVoicePorts } from "../../../packages/gateway/src/voice-session/canonical-ports.js";
import { VoiceMediaAdapterRegistry } from "../../../packages/gateway/src/voice-session/adapter.js";
import { createGeminiCompanionAdapter } from "../../../packages/gateway/src/live-companion/gemini-adapter.js";
import { createCanonicalLivePort } from "../../../packages/gateway/src/live-companion/task-broker.js";
import { CHAT_ID, PRINCIPAL, makeRig, listeningSession, clientFrame } from "../voice-session/fakes.js";

function catalog(): CanonicalProviderCatalog {
  return CanonicalProviderCatalogSchema.parse({
    revision: "catalog_orchestrator",
    drivers: [{
      kind: "codex",
      displayName: "Codex",
      adapterVersion: "1.0.0",
      capabilityClass: "coding_agent",
    }],
    instances: [{
      id: "codex_default",
      driverKind: "codex",
      displayName: "Codex",
      availability: "available",
      workspaceRequirement: "project_optional",
      catalogRevision: "catalog_orchestrator",
      models: [{
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        availability: "available",
        capabilities: ["reasoning", "tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        steering: "same_run",
        attachments: ["file", "image", "structured_ref"],
        tools: [],
        approvals: true,
        userInput: true,
        worktrees: "optional",
        resources: ["file", "folder", "project", "task", "app", "terminal_session"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
    }],
  });
}

/** Only the external speech and execution models are faked. Chat admission,
 * ownership, durable dedup, outbox, task reattachment, transport tickets and
 * voice teardown are the production implementations. No app/build success is
 * inferred from this test provider's completion event.
 */
it("ticket-authenticated native voice creates one durable supervised task that completes after voice ends", async () => {
  const db = await KyselyPGlite.create();
  const repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  const owner = { type: "personal" as const, ownerId: PRINCIPAL.userId };
  const selection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
  await repository.create(owner, { id: CHAT_ID, clientRequestId: "req_native", title: "Aoede", currentSelection: selection });
  let release!: () => void;
  const work = new Promise<void>(resolve => { release = resolve; });
  const providerCalls: string[] = [];
  const execution: CanonicalChatProviderAdapter = {
    driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start(input) {
      providerCalls.push(input.prompt);
      await work;
      yield { type: "assistant.delta", delta: "Task complete; app launch still requires verification." };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  const orchestrator = new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog() }, adapters: new CanonicalChatProviderRegistry([execution]) });
  const deliveries = new ChatVoiceDeliveryRepository(repository.kysely);
  const canonical = createCanonicalVoicePorts({ repository, orchestrator, deliveries });
  const port = createCanonicalLivePort({ repository, orchestrator, principal: PRINCIPAL, chatId: CHAT_ID, selection, taskEvents: canonical.chatEvents });
  const provider = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(), sendAudio: vi.fn(), restoreContext: vi.fn(), sendText: vi.fn(), sendToolResponse: vi.fn(), transcript: "" });
  const adapters = new VoiceMediaAdapterRegistry();
  adapters.register(createGeminiCompanionAdapter({ connection: "fixture", model: "gemini-3.8-live", clientFactory: () => provider }));
  const rig = makeRig({ engine: { ...canonical, adapters, liveHistory: () => port } });
  try {
    const session = await listeningSession(rig, { request: { selection, interactionMode: "default", permissionMode: "supervised" } });
    await session.handle.receive(clientFrame(session.sessionId, session.epoch, { type: "capture.start", turnId: "vturn_one", mode: "hands_free" }));
    provider.emit("input_transcript", { text: "Build a habit tracker" });
    provider.emit("tool_call", { id: "call_build", name: "delegate_task", args: { kind: "build_app", prompt: "ignore me" } });
    await vi.waitFor(() => expect(provider.sendToolResponse).toHaveBeenCalled(), { timeout: 2000 });
    const result = provider.sendToolResponse.mock.calls[0]![1] as { chatId: string; runId: string };
    expect(result).toMatchObject({ status: "sent", scheduling: "WHEN_IDLE" });
    await session.handle.receive(clientFrame(session.sessionId, session.epoch, { type: "session.end", reason: "user" }));
    expect((await repository.get(owner, result.chatId))?.activeRun).toBeTruthy();
    release();
    await orchestrator.drain();
    const detail = await repository.getDetailPage(owner, result.chatId, { limit: 20 });
    expect(detail?.runs[0]?.status).toBe("completed");
    expect(detail?.runs[0]?.permissionMode).toBe("supervised");
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toContain("matrix-app-builder");
    const root = await repository.getDetailPage(owner, CHAT_ID, { limit: 20 });
    const source = root!.messages.find(message => message.role === "user")!;
    const replay = await port.delegate({ sourceId: source.id, kind: "build_app", prompt: "different" });
    expect(replay).toMatchObject({ outcome: "already_accepted", chatId: result.chatId, runId: result.runId });
    for (let index = 0; index < 22; index++) await port.journal({ id: `vturn_later_${index}`, role: "user", text: "Keep talking" });
    expect((await port.resumeTasks?.())?.[0]).toMatchObject({ chatId: result.chatId, state: "succeeded" });
    expect(providerCalls).toHaveLength(1);
    expect(session.sink.frames.every(frame => VoiceServerFrameSchema.safeParse(frame).success)).toBe(true);
  } finally {
    release(); await rig.engine.close(); await orchestrator.drain(); await repository.release(); await repository.kysely.destroy();
  }
});
