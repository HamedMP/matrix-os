import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KyselyPGlite } from "kysely-pglite";
import { CanonicalProviderCatalogSchema, type CanonicalChatRun } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { admitNativeScheduledPhase, type NativeScheduledAdmissionOptions } from "../../packages/gateway/src/chat/native-scheduled-admission.js";

const owner = { type: "personal" as const, ownerId: "owner_native_phase" };
const sessionId = "3f04f47c-2639-4e74-b70c-b0ea347cf266";
const promptId = "76562cfb-7365-45c3-aeab-26a71b9fc71b";
const timestamp = "2026-11-03T00:00:00.000Z";
const selection = { instanceId: "claude_code_default", model: "claude-haiku-4-5-20251001" };
const supports = { rootChat: true, resume: true, cancellation: true, steering: "same_run" as const,
  attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional" as const,
  resources: [], interactionModes: ["default"], permissionModes: ["supervised"] };
const request = { owner, chatId: "chat_native_phase", sourceRunId: "run_source", sessionId, promptId, prompt: "Report the time." };
function catalog(available = true) {
  return CanonicalProviderCatalogSchema.parse({ revision: "catalog_native", drivers: [{ kind: "claude_code",
    displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }], instances: [{ id: selection.instanceId,
    driverKind: "claude_code", displayName: "Claude", availability: available ? "available" : "unavailable",
    workspaceRequirement: "project_optional", catalogRevision: "catalog_native", models: [{ id: selection.model,
      displayName: "Haiku", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
    options: [], skills: [], commands: [], setupActions: [], supports }] });
}

describe("native scheduled phase orchestration", () => {
  let database: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;
  let orchestrator: CanonicalChatOrchestrator | undefined;
  beforeEach(async () => {
    database = await createTestPGlite();repository = new ChatRepository(database.dialect);await repository.bootstrap();
    await repository.create(owner, { id: request.chatId, clientRequestId: "req_create_native", title: "Native" });
    const message = { id: "msg_source", chatId: request.chatId, seq: 1, role: "user" as const, purpose: "ai_request" as const,
      state: "committed" as const, turnId: "cturn_source", parts: [{ type: "text" as const, text: "Create my schedule." }], createdAt: timestamp };
    const turn = { id: "cturn_source", chatId: request.chatId, clientRequestId: "req_source", baseMessageSeq: 0,
      inputMessageId: message.id, status: "accepted" as const, createdAt: timestamp, updatedAt: timestamp };
    const run: CanonicalChatRun = { id: request.sourceRunId, chatId: request.chatId, turnId: turn.id, attempt: 1,
      driverKind: "claude_code", instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "supervised",
      status: "accepted", historyBoundarySeq: 0, capabilitySnapshot: { revision: "catalog_native", ...supports },
      createdAt: timestamp, updatedAt: timestamp };
    await repository.admitTurn(owner, { chatId: request.chatId, baseRevision: 0, message, turn, run });
    await repository.updateAdapterState(owner, { chatId: request.chatId, runId: run.id, driverKind: "claude_code",
      instanceId: selection.instanceId, schemaVersion: 1, state: { sessionId } });
    await repository.finishRun(owner, { chatId: request.chatId, runId: run.id, outcome: "completed", completedAt: timestamp });
  });
  afterEach(async () => { await orchestrator?.close();await repository.kysely.destroy(); });
  function provider(resume: CanonicalChatProviderAdapter<{ sessionId: string }>["resume"]) {
    return { driverKind: "claude_code" as const, stateSchemaVersion: 1,
      parseState: (value: unknown) => value as { sessionId: string }, serializeState: (value: unknown) => value,
      start: vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "failed" as const }; }), resume };
  }
  it("registers a fresh scheduled run before releasing native work and returns without waiting for the phase", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const resume = vi.fn(async function* (input) {
      expect(input.nativeScheduled).toEqual({ sourceRunId: request.sourceRunId, sessionId, promptId });
      expect(input.resumeState).toEqual({ sessionId });
      const persisted = (await repository.exportChat(owner, request.chatId))!;
      expect(persisted.messages.at(-1)?.role).toBe("system");
      expect(persisted.runs.at(-1)?.status).toBe("running");
      yield { type: "assistant.delta" as const, delta: "First scheduled " };
      await Promise.race([held, new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      yield { type: "assistant.delta" as const, delta: "result" };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const adapter = provider(resume);
    orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() } });
    await orchestrator.admitNativeScheduledPhase(request);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(adapter.start).not.toHaveBeenCalled();
    release!();
    await vi.waitFor(async () => expect((await repository.exportChat(owner, request.chatId))!.runs.at(-1)?.status).toBe("completed"));
    const messages = (await repository.exportChat(owner, request.chatId))!.messages;
    expect(messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(messages.at(-1)?.parts).toEqual([{ type: "text", text: "First scheduled result" }]);
  });
  it("holds an immediate native tick until its actual source run finishes canonical persistence", async () => {
    let releaseSource: (() => void) | undefined;
    const heldFinish = new Promise<void>(resolve => { releaseSource = resolve; });
    let finishBlocked = false;
    const finishRun = repository.finishRun.bind(repository);
    vi.spyOn(repository, "finishRun").mockImplementation(async (scope, input) => {
      if (!finishBlocked && input.runId !== request.sourceRunId) { finishBlocked = true;await heldFinish; }
      return finishRun(scope, input);
    });
    const resume = vi.fn(async function* (input) {
      yield { type: "state.updated" as const, state: { sessionId } };
      yield { type: "assistant.delta" as const, delta: input.nativeScheduled ? "Scheduled occurrence" : "Foreground complete" };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const adapter = provider(resume);
    orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() } });
    const record = (await repository.get(owner, request.chatId))!;
    const foreground = await orchestrator.admitTurn({ userId: owner.ownerId, source: "jwt" }, owner, request.chatId, {
      clientRequestId: "req_foreground", baseRevision: record.chat.revision, parts: [{ type: "text", text: "Create the schedule." }],
      selection, interactionMode: "default", permissionMode: "supervised" });
    await vi.waitFor(() => expect(finishBlocked).toBe(true));
    const immediate = orchestrator.admitNativeScheduledPhase({ ...request, sourceRunId: foreground.run.id });
    const outcome = immediate.catch(error => error);
    expect((await repository.exportChat(owner, request.chatId))!.runs).toHaveLength(2);
    expect(resume).toHaveBeenCalledOnce();
    releaseSource!();
    expect(await outcome).toBeUndefined();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
  });
  it("keeps secret-bearing native prompt text out of committed display, context and outbox", async () => {
    const secret = "sk-ant-api03-private-native-schedule-test-only";
    const privatePrompt = `Use ${secret} for the task, then report completion.`;
    const resume = vi.fn(async function* (input) {
      yield { type: "assistant.delta" as const, delta: "Native task finished" };
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const adapter = provider(resume);
    orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() } });
    await orchestrator.admitNativeScheduledPhase({ ...request, prompt: privatePrompt });
    await vi.waitFor(async () => expect((await repository.exportChat(owner, request.chatId))!.runs.at(-1)?.status).toBe("completed"));
    const exported = (await repository.exportChat(owner, request.chatId))!;
    const detail = await repository.getDetailPage(owner, request.chatId, { limit: 100 });
    const outbox = await repository.replayOutbox(owner, { afterCursor: 0, limit: 100 });
    for (const surface of [exported, detail, outbox]) {
      expect(JSON.stringify(surface)).not.toContain(secret);
      expect(JSON.stringify(surface)).not.toContain(privatePrompt);
    }
    expect(exported.messages.find(message => message.role === "system")?.parts)
      .toEqual([{ type: "text", text: "Scheduled task triggered." }]);
    expect(resume.mock.calls[0]![0].parts).toEqual([{ type: "text", text: "Scheduled task triggered." }]);
    expect(resume.mock.calls[0]![0].prompt).not.toContain(secret);
    expect(adapter.start).not.toHaveBeenCalled();expect(resume).toHaveBeenCalledOnce();
  });
  it("rechecks the current provider catalog and declines disabled sources before admission", async () => {
    const adapter = provider(vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; }));
    orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog(false) } });
    await expect(orchestrator.admitNativeScheduledPhase(request)).rejects.toThrow();
    expect((await repository.exportChat(owner, request.chatId))!.runs).toHaveLength(1);
    expect(adapter.resume).not.toHaveBeenCalled();
  });
  it("settles a newly admitted run on synchronous registration failure", async () => {
    const adapter = provider(vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; }));
    const reserve = vi.fn(), release = vi.fn();
    const deps: NativeScheduledAdmissionOptions = { repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() }, assertOpen() {}, assertPersonalExecutionAllowed: async () => {},
      atCapacity: () => false, hasStoppingExecution: () => false, reservePendingDispatch: reserve,
      releasePendingDispatch: release, registerDispatch() { throw new Error("Registration failed"); } };
    await expect(admitNativeScheduledPhase(deps, request)).rejects.toThrow("Registration failed");
    const persisted = (await repository.exportChat(owner, request.chatId))!;
    expect(persisted.runs).toHaveLength(2);expect(persisted.runs.at(-1)?.status).toBe("failed");
    expect(reserve).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledWith(reserve.mock.calls[0]![0]);
  });
  it("does not count its pending reservation as its own active slot", async () => {
    const adapter = provider(vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; }));
    let active = 7, pending = 0;
    const registered = vi.fn(() => { active++;return { registered: true as const }; });
    await admitNativeScheduledPhase({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() }, assertOpen() {}, assertPersonalExecutionAllowed: async () => {},
      atCapacity: () => active >= 8, hasStoppingExecution: () => false,
      reservePendingDispatch: () => { pending++; }, releasePendingDispatch: () => { pending--; }, registerDispatch: registered }, request);
    expect(registered).toHaveBeenCalledOnce();expect(active).toBe(8);expect(pending).toBe(0);
  });
  it("uses the existing canonical failure path for preparation errors without replaying a native prompt", async () => {
    const resume = vi.fn(async function* () { throw new Error("Native phase no longer attachable"); });
    const adapter = provider(resume);
    orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]),
      catalog: { getCatalog: async () => catalog() } });
    await orchestrator.admitNativeScheduledPhase(request);
    await vi.waitFor(async () => expect((await repository.exportChat(owner, request.chatId))!.runs.at(-1)?.status).toBe("failed"));
    expect(resume).toHaveBeenCalledOnce();expect(adapter.start).not.toHaveBeenCalled();
  });
});
