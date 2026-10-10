import {
  CanonicalProviderCatalogSchema,
  type CanonicalProviderCatalog,
  type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import {
  CanonicalChatProviderRegistry,
  type CanonicalChatProviderAdapter,
} from "../../packages/gateway/src/chat/provider-adapter.js";
import { admitCanonicalTurn } from "../../packages/gateway/src/chat/turn-admission.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createPreviewDriveWiring } from "../../packages/gateway/src/chat/preview-drive-wiring.js";

const owner = { type: "personal" as const, ownerId: "owner_orchestrator" };
const principal = { userId: owner.ownerId, source: "jwt" as const };

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

function adapter(
  start: CanonicalChatProviderAdapter<{ sessionId: string }>["start"],
): CanonicalChatProviderAdapter<{ sessionId: string }> {
  return {
    driverKind: "codex",
    stateSchemaVersion: 1,
    parseState(value) {
      if (!value || typeof value !== "object" || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
        throw new Error("invalid state");
      }
      return value as { sessionId: string };
    },
    serializeState: (value) => value,
    start,
  };
}

describe("Preview turn dispatch admission", () => {
  let repository: ChatRepository;
  const orchestrators: CanonicalChatOrchestrator[] = [];
  const admissionGates: Array<{ resolve(): void }> = [];
  const pending: Array<Promise<unknown>> = [];
  const executions: Array<{ release(): void }> = [];
  beforeEach(async () => {
    const instance = await createTestPGlite();
    repository = new ChatRepository(instance.dialect); await repository.bootstrap();
  });
  afterEach(async () => {
    for (const gate of admissionGates.splice(0)) gate.resolve();
    await Promise.allSettled(pending.splice(0));
    for (const orchestrator of orchestrators.splice(0)) {
      // Release fake external providers in order; PGlite has one physical connection.
      let released = 0;
      while (orchestrator.activeCount > 0) {
        await vi.waitFor(() => expect(executions.length).toBeGreaterThan(released));
        const count = orchestrator.activeCount;
        executions[released++]!.release();
        await vi.waitFor(() => expect(orchestrator.activeCount).toBeLessThan(count));
      }
      await orchestrator.drain();
    }
    executions.length = 0;
    await repository.kysely.destroy();
  });

  it("redeems a Preview browser turn proof after admission but before Claude starts", async () => {
    await repository.create(owner, { id: "chat_preview", clientRequestId: "req_preview_create", title: "Preview" });
    const claudeCatalog = catalog();
    const instance = claudeCatalog.instances[0]!;
    const previewCatalog = CanonicalProviderCatalogSchema.parse({ ...claudeCatalog,
      drivers: [{ ...claudeCatalog.drivers[0], kind: "claude_code" }],
      instances: [{ ...instance, id: "claude_code_default", driverKind: "claude_code" }],
    });
    const order: string[] = [];
    const beforeDispatch = vi.fn(async (input: { runId: string; proof: string }) => {
      order.push("redeem"); expect(input.runId).toMatch(/^run_/); expect(input.proof).toBe("browser-proof");
    });
    const provider = { ...adapter(async function* () { order.push("start");
      yield { type: "run.completed", outcome: "completed" }; }), driverKind: "claude_code" as const };
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => previewCatalog },
      adapters: new CanonicalChatProviderRegistry([provider]), beforePreviewDispatch: beforeDispatch });
    const request = { clientRequestId: "req_preview_turn", baseRevision: 0,
      parts: [{ type: "text" as const, text: "List three Drive files" }],
      selection: { instanceId: "claude_code_default", model: "gpt-5.6-sol" },
      interactionMode: "default" as const, permissionMode: "supervised" as const };
    await orchestrator.admitTurn(principal, owner, "chat_preview", request, { previewTurnProof: "browser-proof" });
    await orchestrator.drain();
    expect(order).toEqual(["redeem", "start"]);
    expect(beforeDispatch).toHaveBeenCalledWith(expect.objectContaining({ actorId: owner.ownerId,
      chatId: "chat_preview", clientRequestId: "req_preview_turn", body: request }));
  });


  function previewCatalog() {
    const value = catalog();
    return CanonicalProviderCatalogSchema.parse({ ...value,
      drivers: [{ ...value.drivers[0], kind: "claude_code" }],
      instances: [{ ...value.instances[0], id: "claude_code_default", driverKind: "claude_code" }],
    });
  }
  function request(key: string) {
    return { clientRequestId: `req_${key}`, baseRevision: 0,
      parts: [{ type: "text" as const, text: "List three Drive files" }],
      selection: { instanceId: "claude_code_default", model: "gpt-5.6-sol" },
      interactionMode: "default" as const, permissionMode: "supervised" as const };
  }
  function setup() {
    const entered: string[] = [];
    const cleanup = vi.fn<(chatId: string) => void>();
    const gate = Promise.withResolvers<void>(); admissionGates.push(gate);
    const provider = { ...adapter(async function* () {
      const release = Promise.withResolvers<void>();
      executions.push({ release: () => release.resolve() });
      await release.promise;
      yield { type: "run.completed" as const, outcome: "completed" as const };
    }), driverKind: "claude_code" as const };
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => previewCatalog() }, adapters: new CanonicalChatProviderRegistry([provider]),
      beforePreviewDispatch: async input => { entered.push(input.chatId); await gate.promise;
        return () => cleanup(input.chatId); }, shutdownDrainMs: 20 });
    orchestrators.push(orchestrator);
    return { orchestrator, entered, gate, cleanup };
  }
  async function begin(orchestrator: CanonicalChatOrchestrator, key: string, actor = owner, preview = true,
    override: Partial<CanonicalCreateChatTurnRequest> = {}) {
    const chatId = `chat_${key}`;
    await repository.create(actor, { id: chatId, clientRequestId: `req_create_${key}`, title: key });
    const result = orchestrator.admitTurn({ ...principal, userId: actor.ownerId }, actor, chatId, { ...request(key), ...override },
      preview ? { previewTurnProof: "browser-proof" } : undefined)
      .then(value => ({ accepted: true as const, value }), error => ({ accepted: false as const, error }));
    pending.push(result); return { result, chatId };
  }

  it("rechecks owner capacity when nine admitted Preview turns resume together", async () => {
    const { orchestrator, entered, gate, cleanup } = setup();
    const turns = [];
    try {
      for (let index = 0; index < 9; index++) {
        turns.push(await begin(orchestrator, `owner_${index}`));
        await vi.waitFor(() => expect(entered).toHaveLength(index + 1));
      }
      expect(orchestrator.activeCount).toBe(0);
      gate.resolve();
      const outcomes = await Promise.all(turns.map(turn => turn.result));
      expect(orchestrator.activeCount).toBe(8);
      expect(outcomes.filter(value => value.accepted)).toHaveLength(8);
      const rejectedIndex = outcomes.findIndex(value => !value.accepted);
      const rejected = outcomes[rejectedIndex]!;
      expect(rejected).toMatchObject({ accepted: false, error: { status: 503,
        safeError: { code: "run_unavailable", safeMessage: "Chat execution is temporarily busy.", retryable: true } } });
      expect((await repository.exportChat(owner, turns[rejectedIndex]!.chatId))?.runs[0]?.status).toBe("failed");
      expect(cleanup.mock.calls).toEqual([[turns[rejectedIndex]!.chatId]]);
    } finally { gate.resolve(); }
  });

  it("rechecks global capacity filled by ordinary admissions while a Preview redemption waits", async () => {
    const { orchestrator, entered, gate, cleanup } = setup();
    const held = await begin(orchestrator, "global_held");
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(1));
      for (let index = 0; index < 64; index++) {
        const actor = { ...owner, ownerId: `global_owner_${Math.floor(index / 8)}` };
        const turn = await begin(orchestrator, `global_${index}`, actor, false);
        expect((await turn.result).accepted).toBe(true);
        await vi.waitFor(() => expect(executions).toHaveLength(index + 1));
      }
      expect(orchestrator.activeCount).toBe(64);
      gate.resolve();
      expect(await held.result).toMatchObject({ accepted: false, error: { status: 503,
        safeError: { code: "run_unavailable", safeMessage: "Chat execution is temporarily busy." } } });
      expect(orchestrator.activeCount).toBe(64);
      expect((await repository.exportChat(owner, held.chatId))?.runs[0]?.status).toBe("failed");
      expect(cleanup.mock.calls).toEqual([[held.chatId]]);
    } finally { gate.resolve(); }
  });

  it("fails an admitted Preview run if shutdown begins during redemption", async () => {
    const { orchestrator, entered, gate, cleanup } = setup();
    const held = await begin(orchestrator, "shutdown_held");
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(1));
      await orchestrator.close();
      gate.resolve();
      expect(await held.result).toMatchObject({ accepted: false, error: { status: 503,
        safeError: { code: "run_unavailable", safeMessage: "Chat execution is shutting down." } } });
      expect(orchestrator.activeCount).toBe(0);
      expect(executions).toHaveLength(0);
      expect((await repository.exportChat(owner, held.chatId))?.runs[0]?.status).toBe("failed");
      expect(cleanup.mock.calls).toEqual([[held.chatId]]);
    } finally { gate.resolve(); }
  });

  it.each(["account", "root", "mark-running", "activity"] as const)(
    "revokes unused Preview authority when asynchronous %s startup fails", async stage => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn: async () => "a".repeat(64), revoke } });
    let redeemed = false;
    const failure = new Error("Startup dependency unavailable");
    const storage = stage === "mark-running" ? vi.spyOn(repository, "markRunRunning").mockRejectedValueOnce(failure)
      : stage === "activity" ? vi.spyOn(repository, "appendRunActivities").mockRejectedValueOnce(failure) : undefined;
    const root = { ref: { kind: "project" as const, projectId: "project_startup" },
      fingerprint: "f".repeat(64), primaryWorkspaceRoot: "/safe/project" };
    const start = vi.fn(async function* () {
      yield { type: "run.completed" as const, outcome: "completed" as const };
    });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => previewCatalog() },
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(start), driverKind: "claude_code" }]),
      collaborationGuard: { assertPersonalExecutionAllowed: async () => {
        if (redeemed && stage === "account") throw failure;
      } },
      ...(stage === "root" ? { executionRoots: { resolve: async () => root, revalidate: async () => { throw failure; } } } : {}),
      beforePreviewDispatch: async input => {
        const cleanup = await wiring.beforeDispatch!(input);
        redeemed = true;
        return cleanup;
      } });
    orchestrators.push(orchestrator);
    try {
      const turn = await begin(orchestrator, `startup_${stage}`, owner, true,
        stage === "root" ? { executionRoot: root.ref } : {});
      const result = await turn.result;
      expect(result.accepted).toBe(true);
      if (!result.accepted) throw result.error;
      await orchestrator.drain();
      expect(start).not.toHaveBeenCalled();
      expect((await repository.exportChat(owner, turn.chatId))?.runs[0]?.status).toBe("failed");
      expect(revoke).toHaveBeenCalledExactlyOnceWith({ runGrant: "a".repeat(64),
        chatId: turn.chatId, runId: result.value.run.id });
      expect(registry.issue({ owner, runId: result.value.run.id, scope: "chat_call" })).toBeNull();
    } finally { await orchestrator.drain(); storage?.mockRestore(); registry.close(); }
  });

  it("disposes a pending Preview grant when cancellation wins before mark-running", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn: async () => "b".repeat(64), revoke } });
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const markRunning = repository.markRunRunning.bind(repository);
    const mark = vi.spyOn(repository, "markRunRunning").mockImplementation(async (actor, input) => {
      entered.resolve(); await gate.promise; return markRunning(actor, input);
    });
    const start = vi.fn(async function* () { yield { type: "run.completed" as const, outcome: "completed" as const }; });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => previewCatalog() },
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(start), driverKind: "claude_code" }]),
      beforePreviewDispatch: wiring.beforeDispatch });
    orchestrators.push(orchestrator);
    try {
      const turn = await begin(orchestrator, "cancel_startup"), result = await turn.result;
      expect(result.accepted).toBe(true);
      if (!result.accepted) throw result.error;
      await entered.promise;
      expect(revoke).not.toHaveBeenCalled();
      expect((await orchestrator.cancelRun(owner, turn.chatId, result.value.run.id)).cancellation).toBe("aborted");
      gate.resolve(); await orchestrator.drain();
      expect(start).not.toHaveBeenCalled();
      expect((await repository.exportChat(owner, turn.chatId))?.runs[0]?.status).toBe("aborted");
      expect(revoke).toHaveBeenCalledExactlyOnceWith({ runGrant: "b".repeat(64), chatId: turn.chatId, runId: result.value.run.id });
      expect(registry.issue({ owner, runId: result.value.run.id, scope: "chat_call" })).toBeNull();
    } finally { gate.resolve(); await orchestrator.drain(); mark.mockRestore(); registry.close(); }
  });

  it("leaves an issued Preview capability with its provider when dispatch completes", async () => {
    const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
    const revoke = vi.fn(async () => undefined);
    const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
      client: { redeemTurn: async () => "c".repeat(64), revoke } });
    let capability: ReturnType<typeof registry.issue>;
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: { getCatalog: async () => previewCatalog() },
      adapters: new CanonicalChatProviderRegistry([{ ...adapter(async function* (input) {
        capability = registry.issue({ owner: input.owner, runId: input.runId, scope: "chat_call" });
        yield { type: "run.completed" as const, outcome: "completed" as const };
      }), driverKind: "claude_code" }]), beforePreviewDispatch: wiring.beforeDispatch });
    orchestrators.push(orchestrator);
    try {
      const turn = await begin(orchestrator, "issued_startup");
      expect((await turn.result).accepted).toBe(true);
      await orchestrator.drain();
      expect(capability!).not.toBeNull();
      expect(registry.resolve(capability!.token, "GET", "/api/integrations")).toBe(owner.ownerId);
      expect(revoke).not.toHaveBeenCalled();
      capability!.revoke();
      expect(revoke).toHaveBeenCalledOnce();
    } finally { await orchestrator.drain(); registry.close(); }
  });

  it.each(["resolved", "rejected"] as const)(
    "disposes unused authority on %s completion and isolates a synchronous disposer failure", async outcome => {
      const registry = createMatrixMcpCapabilityRegistry({ previewRuntime: true });
      const revoke = vi.fn(async () => undefined), release = vi.fn();
      const completion = Promise.withResolvers<void>();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const wiring = createPreviewDriveWiring({ previewRuntime: true, registry,
        client: { redeemTurn: async () => "d".repeat(64), revoke } });
      const key = `completion_${outcome}`, chatId = `chat_${key}`;
      await repository.create(owner, { id: chatId, clientRequestId: `req_create_${key}`, title: "Completion" });
      try {
        const result = await admitCanonicalTurn({ repository,
          catalog: { getCatalog: async () => previewCatalog() },
          adapters: new CanonicalChatProviderRegistry([{ ...adapter(async function* () {}), driverKind: "claude_code" }]),
          assertOpen: () => {}, assertPersonalExecutionAllowed: async () => {}, reconcileActiveRuns: async () => {},
          reservePendingDispatch: () => {}, releasePendingDispatch: release,
          atCapacity: () => false, hasStoppingExecution: () => false,
          beforePreviewDispatch: async input => {
            const cleanup = await wiring.beforeDispatch!(input);
            return () => { cleanup!(); throw new Error("private cleanup detail"); };
          }, startDispatch: () => completion.promise,
        }, principal, owner, chatId, request(key), { previewTurnProof: "browser-proof" });
        expect(result.admission).toBe("accepted");
        expect(release).toHaveBeenCalledOnce();
        expect(revoke).not.toHaveBeenCalled();
        if (outcome === "resolved") completion.resolve(); else completion.reject(new Error("private dispatch detail"));
        await vi.waitFor(() => expect(revoke).toHaveBeenCalledExactlyOnceWith({ runGrant: "d".repeat(64), chatId, runId: result.run.id }));
        expect(registry.issue({ owner, runId: result.run.id, scope: "chat_call" })).toBeNull();
        expect(warn).toHaveBeenCalledExactlyOnceWith("[chat] Preview Drive admission cleanup failed", "Error");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
      } finally { completion.resolve(); warn.mockRestore(); registry.close(); }
    },
  );

  it("retains cleanup ownership after a healthy synchronous dispatch", async () => {
    const { orchestrator, entered, gate, cleanup } = setup();
    const held = await begin(orchestrator, "healthy_cleanup");
    await vi.waitFor(() => expect(entered).toHaveLength(1));
    gate.resolve();
    expect((await held.result).accepted).toBe(true);
    expect(orchestrator.activeCount).toBe(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each(["persistence", "start"] as const)(
    "disposes redeemed authority and releases pending admission after %s failure even if cleanup throws",
    async failure => {
      const chatId = `chat_cleanup_${failure}`;
      await repository.create(owner, { id: chatId, clientRequestId: `req_create_cleanup_${failure}`, title: "Cleanup" });
      const error = new Error("controlled failure");
      const cleanup = vi.fn(() => { throw new Error("cleanup failure"); });
      const release = vi.fn();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let redeemed = false;
      const finish = failure === "persistence" ? vi.spyOn(repository, "finishRun").mockRejectedValue(error) : undefined;
      try {
        await expect(admitCanonicalTurn({ repository,
          catalog: { getCatalog: async () => previewCatalog() },
          adapters: new CanonicalChatProviderRegistry([{ ...adapter(async function* () {}), driverKind: "claude_code" }]),
          assertOpen: () => { if (redeemed && failure === "persistence") throw new Error("closed"); },
          assertPersonalExecutionAllowed: async () => undefined, reconcileActiveRuns: async () => undefined,
          reservePendingDispatch: () => undefined, releasePendingDispatch: release,
          atCapacity: () => false, hasStoppingExecution: () => false,
          beforePreviewDispatch: async () => { redeemed = true; return cleanup; },
          startDispatch: () => { throw error; },
        }, principal, owner, chatId, request(`cleanup_${failure}`), { previewTurnProof: "browser-proof" }))
          .rejects.toBe(error);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith("[chat] Preview Drive admission cleanup failed", "Error");
      } finally { finish?.mockRestore(); warn.mockRestore(); }
    },
  );

});
