import { createClaudePermissionControl } from "../../packages/gateway/src/chat/claude-permission-control.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { createChatRoutineSourceProducer } from "../../packages/gateway/src/chat/routine-chat-source.js";
import { routineActionPolicy } from "../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { permissionModeActivityId } from "../../packages/gateway/src/chat/permission-mode-repository.js";
import { setCanonicalPermissionMode } from "../../packages/gateway/src/chat/permission-mode-control.js";
import type { CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

describe("Chat effective permission persistence", () => {
  let repository: ChatRepository;
  const owner = { type: "personal" as const, ownerId: "owner_permission" };
  const timestamp = "2026-11-13T19:00:00.000Z";

  beforeEach(async () => {
    const database = await createTestPGlite();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  async function admit() {
    const { chat } = await repository.create(owner, {
      id: "chat_permission", clientRequestId: "req_create_permission", title: "Permission mode",
    });
    const snapshot: CanonicalChatRun["capabilitySnapshot"] = {
      revision: "catalog_permission", rootChat: true, attachments: [], resources: [], tools: [],
      approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run",
      worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised", "full_access"],
    };
    await repository.admitTurn(owner, {
      chatId: chat.id, baseRevision: chat.revision,
      message: { id: "msg_permission", chatId: chat.id, seq: 1, role: "user", state: "committed",
        purpose: "ai_request", turnId: "cturn_permission", parts: [{ type: "text", text: "Inspect files" }], createdAt: timestamp },
      turn: { id: "cturn_permission", chatId: chat.id, clientRequestId: "req_turn_permission", baseMessageSeq: 0,
        inputMessageId: "msg_permission", status: "accepted", createdAt: timestamp, updatedAt: timestamp },
      run: { id: "run_permission", chatId: chat.id, turnId: "cturn_permission", attempt: 1,
        driverKind: "claude_code", instanceId: "claude_code_default",
        selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default",
        permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0, capabilitySnapshot: snapshot,
        createdAt: timestamp, updatedAt: timestamp },
    });
    await repository.markRunRunning(owner, { chatId: chat.id, runId: "run_permission", startedAt: timestamp });
    return { chat, snapshot };
  }

  function retryRuntime() {
    const start = vi.fn<CanonicalChatProviderAdapter["start"]>(async function* () { yield { type: "run.completed", outcome: "completed" }; });
    const adapter: CanonicalChatProviderAdapter = { driverKind: "claude_code", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value, start };
    const catalog = CanonicalProviderCatalogSchema.parse({ revision: "catalog_permission", drivers: [{ kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }], instances: [{
      id: "claude_code_default", driverKind: "claude_code", displayName: "Claude", availability: "available", workspaceRequirement: "none", catalogRevision: "catalog_permission",
      models: [{ id: "claude-sonnet-4-5", displayName: "Claude", availability: "available", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }], options: [], skills: [], commands: [], setupActions: [],
      supports: { rootChat: true, resume: false, cancellation: true, steering: "same_run", attachments: [], tools: [], approvals: true, userInput: true, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["supervised", "full_access"] },
    }] });
    const orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry([adapter]), catalog: { getCatalog: async () => catalog } });
    return { orchestrator, start };
  }

  it("reloads the acknowledged effective mode while retaining admission capabilities", async () => {
    const { chat, snapshot } = await admit();
    for (const phase of ["pending", "applied", "confirmed"] as const) await repository.appendRunActivities(owner, chat.id, "run_permission", [{
      id: permissionModeActivityId("run_permission", "req_live_permission", phase), phase,
      chatId: chat.id, runId: "run_permission", occurredAt: timestamp,
      type: "run.permission_mode", permissionMode: "full_access", clientRequestId: "req_live_permission",
    }]);
    const reloaded = await repository.exportChat(owner, chat.id);
    expect(reloaded?.runs[0]?.permissionMode).toBe("full_access");
    expect(reloaded?.runs[0]?.capabilitySnapshot).toEqual(snapshot);
    expect(reloaded?.activities).toContainEqual(expect.objectContaining({
      type: "run.permission_mode", permissionMode: "full_access", clientRequestId: "req_live_permission",
    }));
  });

  it("serializes durable idempotency and rejects changed or superseded request identities", async () => {
    const { chat, snapshot } = await admit();
    const control = vi.fn<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>(async input => {
      if (input.permissionModeProof !== "signed") throw new Error("Proof rejected");
      await input.begin(); await input.commit();
    });
    const controller = new AbortController();
    const options = { repository, active: { owner, chatId: chat.id, controller,
      adapter: { setPermissionMode: control } as unknown as CanonicalChatProviderAdapter } };
    const input = { clientRequestId: "req_mode_one", permissionMode: "full_access" as const };
    const provenance = { permissionModeProof: "signed" };
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", input, provenance)).resolves.toMatchObject({ submission: "accepted" });
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", input, provenance)).resolves.toMatchObject({ submission: "already_applied" });
    expect(control).toHaveBeenCalledOnce();
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", { ...input, permissionMode: "supervised" }, provenance)).rejects.toThrow();
    await setCanonicalPermissionMode(options, owner, chat.id, "run_permission", { clientRequestId: "req_mode_two", permissionMode: "supervised" }, provenance);
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", input, provenance)).rejects.toThrow();
    const reloaded = await repository.exportChat(owner, chat.id);
    expect(reloaded?.runs[0]?.permissionMode).toBe("supervised");
    expect(reloaded?.runs[0]?.capabilitySnapshot).toEqual(snapshot);
    expect(control).toHaveBeenCalledTimes(2);
  });

  it("rejects wrong owners, runs, unavailable controls and invalid proofs without persisting a mode", async () => {
    const { chat } = await admit();
    const control = vi.fn<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>(async () => { throw new Error("Proof rejected"); });
    const options = { repository, active: { owner, chatId: chat.id, controller: new AbortController(),
      adapter: { setPermissionMode: control } as unknown as CanonicalChatProviderAdapter } };
    const input = { clientRequestId: "req_mode_one", permissionMode: "full_access" as const };
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", input)).rejects.toThrow();
    await expect(setCanonicalPermissionMode(options, { ...owner, ownerId: "other_owner" }, chat.id, "run_permission", input, { permissionModeProof: "signed" })).rejects.toThrow();
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_other", input, { permissionModeProof: "signed" })).rejects.toThrow();
    expect(control).not.toHaveBeenCalled();
    await expect(setCanonicalPermissionMode(options, owner, chat.id, "run_permission", input, { permissionModeProof: "forged" })).rejects.toThrow();
    expect((await repository.exportChat(owner, chat.id))?.runs[0]?.permissionMode).toBe("supervised");
    expect((await repository.exportChat(owner, chat.id))?.activities.filter(event => event.type === "run.permission_mode")).toEqual([]);
  });
  it("wires the bounded HTTP owner operation through the service to durable permission state", async () => {
    const { chat } = await admit();
    const control = vi.fn<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>(async input => { await input.begin(); await input.commit(); });
    const options = { repository, active: { owner, chatId: chat.id, controller: new AbortController(), adapter: { setPermissionMode: control } as unknown as CanonicalChatProviderAdapter } };
    const service = createCanonicalChatService(repository, { orchestrator: { setPermissionMode: (
      requestedOwner: typeof owner, chatId: string, runId: string, input: Parameters<typeof setCanonicalPermissionMode>[4], provenance: Parameters<typeof setCanonicalPermissionMode>[5],
    ) => setCanonicalPermissionMode(options, requestedOwner, chatId, runId, input, provenance) } as never });
    const routes = createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: owner.ownerId, source: "jwt" }) });
    const path = `/api/chats/${chat.id}/runs/run_permission/permission-mode`;
    const headers = { "content-type": "application/json", "x-matrix-chat-permission-mode-proof": "signed" };
    expect((await routes.request(path, { method: "POST", headers, body: JSON.stringify({ clientRequestId: "req_invalid", permissionMode: "everything" }) })).status).toBe(400);
    expect((await routes.request(path, { method: "POST", headers, body: "x".repeat(5000) })).status).toBe(413);
    expect(control).not.toHaveBeenCalled();
    const response = await routes.request(path, { method: "POST", headers, body: JSON.stringify({ clientRequestId: "req_http", permissionMode: "full_access" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ permissionMode: "full_access", submission: "accepted" });
    expect((await repository.exportChat(owner, chat.id))?.runs[0]?.permissionMode).toBe("full_access");
  });
  it("keeps the real routine source valid across owner mode changes without widening exact consent", async () => {
    const { chat } = await admit();
    const source = createChatRoutineSourceProducer({ computerId: "computer_one", signal: new AbortController().signal, current: () => true, publish: () => {},
      input: { owner, chatId: chat.id, turnId: "cturn_permission", runId: "run_permission", prompt: "Inspect files", parts: [{ type: "text", text: "Inspect files" }],
        selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal } });
    const valid = () => repository.kysely.transaction().execute(trx => source.producer.validateWithin(source.producer.source, trx as never));
    expect(await valid()).toBe(true);
    for (const [index, permissionMode] of (["full_access", "supervised"] as const).entries()) {
      for (const phase of ["pending", "applied", "confirmed"] as const) await repository.appendRunActivities(owner, chat.id, "run_permission", [{ type: "run.permission_mode",
        id: permissionModeActivityId("run_permission", `req_routine_mode_${index}`, phase), phase,
        chatId: chat.id, runId: "run_permission", occurredAt: timestamp, clientRequestId: `req_routine_mode_${index}`, permissionMode }]);
      expect(await valid()).toBe(true);
      const policy = source.producer.readPolicy();
      expect(policy.originCeiling).toBe("exact");
      expect(routineActionPolicy(source.producer.source, policy, "control")).toBe("ask");
    }
    await repository.kysely.updateTable("chat_runs").set({ permission_mode: "auto" }).where("id", "=", "run_permission").execute();
    expect(await valid()).toBe(false);
  });
  it.each([
    { initialMode: "supervised", targetMode: "full_access" },
    { initialMode: "full_access", targetMode: "supervised" },
  ] as const)("rejects retry after delayed $initialMode→$targetMode persistence and process loss", async ({ initialMode, targetMode }) => {
    const { chat } = await admit();
    if (initialMode === "full_access") {
      const setup = { async setPermissionMode(input: Parameters<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>[0]) { await input.begin(); await input.commit(); } } as unknown as CanonicalChatProviderAdapter;
      await setCanonicalPermissionMode({ repository, active: { owner, chatId: chat.id, controller: new AbortController(), adapter: setup } }, owner, chat.id, "run_permission",
        { clientRequestId: "req_initial_full", permissionMode: "full_access" }, { permissionModeProof: "signed" });
    }
    let stored!: () => void, release!: () => void;
    const persisted = new Promise<void>(resolve => { stored = resolve; });
    const lateAck = new Promise<void>(resolve => { release = resolve; });
    const wrapped = { getPermissionModeContext: repository.getPermissionModeContext.bind(repository),
      async appendRunActivities(...args: Parameters<ChatRepository["appendRunActivities"]>) {
        const event = args[3][0] as { type: string; phase?: string };
        const result = await repository.appendRunActivities(...args);
        if (event.type === "run.permission_mode" && (!event.phase || event.phase === "applied")) { stored(); await lateAck; }
        return result;
      } };
    const controller = new AbortController();
    let control!: ReturnType<typeof createClaudePermissionControl>;
    control = createClaudePermissionControl({ chatId: chat.id, runId: "run_permission", initialMode, enabled: true,
      signal: controller.signal, verify: async () => true, supervisedSettings: { sandbox: { enabled: true } }, setAuthority: async () => {}, allowPending: async () => {}, dispatch: () => false,
      abort: () => controller.abort(), async write(frame) {
        const value = JSON.parse(frame) as { request_id: string; request: { subtype: string; mode?: string } };
        queueMicrotask(() => control.handle({ type: "control_response", response: { subtype: "success", request_id: value.request_id,
          response: value.request.subtype === "set_permission_mode" ? { mode: value.request.mode } : {} } }));
      } });
    const active = { owner, chatId: chat.id, controller, adapter: { setPermissionMode: control.change } as unknown as CanonicalChatProviderAdapter };
    const failed = expect(setCanonicalPermissionMode({ repository: wrapped, active }, owner, chat.id, "run_permission",
      { clientRequestId: "req_late_mode", permissionMode: targetMode }, { permissionModeProof: "signed" })).rejects.toThrow();
    await persisted;
    expect((await repository.exportChat(owner, chat.id))?.runs[0]?.permissionMode).toBe(initialMode);
    controller.abort(); await failed; release(); await lateAck;
    // A fresh process performs real recovery with no native/memory failure flag.
    const fresh = retryRuntime();
    try {
      expect(await fresh.orchestrator.reconcileActiveRuns(owner)).toBe(1);
      const record = await repository.get(owner, chat.id);
      await expect(fresh.orchestrator.retryTurn({ userId: owner.ownerId, source: "jwt" }, owner, chat.id, "cturn_permission",
        { clientRequestId: "req_retry_late", baseRevision: record!.chat.revision })).rejects.toMatchObject({ status: 409 });
      expect(fresh.start).not.toHaveBeenCalled();
      expect((await repository.exportChat(owner, chat.id))?.runs).toHaveLength(1);
    } finally { await fresh.orchestrator.close(); control.close(); }
  });

  it("requires exact pending and applied receipts before terminal confirmation", async () => {
    const { chat, snapshot } = await admit();
    const clientRequestId = "req_terminal_confirmation";
    const append = (phase: "pending" | "applied" | "confirmed", permissionMode: "full_access" | "supervised" = "full_access") => repository.appendRunActivities(owner, chat.id, "run_permission", [{
      type: "run.permission_mode", id: permissionModeActivityId("run_permission", clientRequestId, phase), phase,
      chatId: chat.id, runId: "run_permission", occurredAt: timestamp, clientRequestId, permissionMode,
    }]);
    await append("pending");
    await expect(setCanonicalPermissionMode({ repository }, owner, chat.id, "run_permission", { clientRequestId, permissionMode: "full_access" }, { permissionModeProof: "signed" })).rejects.toThrow();
    await repository.finishRun(owner, { chatId: chat.id, runId: "run_permission", outcome: "completed", completedAt: timestamp });
    await expect(append("confirmed")).rejects.toThrow();
    expect((await repository.exportChat(owner, chat.id))?.runs[0]?.permissionMode).toBe("supervised");
    // No terminal applied write can manufacture native success.
    await expect(append("applied")).rejects.toThrow();
    expect((await repository.getTurnRunContext(owner, chat.id, "cturn_permission"))?.permissionModeUnconfirmed).toBe(true);
    expect((await repository.exportChat(owner, chat.id))?.runs[0]?.capabilitySnapshot).toEqual(snapshot);
  });

  it("confirms a fully successful native grant after fast completion and resolves an identical lost-response retry", async () => {
    const { chat } = await admit();
    const adapter = { async setPermissionMode(input: Parameters<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>[0]) {
      await input.begin(); await input.commit();
      expect((await repository.exportChat(owner, chat.id))?.runs[0]?.permissionMode).toBe("supervised");
      await repository.finishRun(owner, { chatId: chat.id, runId: "run_permission", outcome: "completed", completedAt: timestamp });
    } } as unknown as CanonicalChatProviderAdapter;
    const input = { clientRequestId: "req_fast_complete", permissionMode: "full_access" as const };
    const lostAck = { getPermissionModeContext: repository.getPermissionModeContext.bind(repository),
      async appendRunActivities(...args: Parameters<ChatRepository["appendRunActivities"]>) {
        const result = await repository.appendRunActivities(...args);
        if (args[3][0]?.type === "run.permission_mode" && args[3][0].phase === "confirmed") throw new Error("Confirmation ACK lost");
        return result;
      } };
    await expect(setCanonicalPermissionMode({ repository: lostAck, active: { owner, chatId: chat.id, adapter, controller: new AbortController() } }, owner, chat.id, "run_permission", input, { permissionModeProof: "signed" })).rejects.toMatchObject({ status: 503 });
    await expect(setCanonicalPermissionMode({ repository }, owner, chat.id, "run_permission", input, { permissionModeProof: "signed" })).resolves.toMatchObject({ submission: "already_applied" });
    expect((await repository.getTurnRunContext(owner, chat.id, "cturn_permission"))?.permissionModeUnconfirmed).toBe(false);
  });

  it("rechecks unmatched intent under the retry admission lock after stale preflight", async () => {
    const { chat } = await admit();
    const before = (await repository.getTurnRunContext(owner, chat.id, "cturn_permission"))!;
    expect(before.permissionModeUnconfirmed).toBe(false);
    await repository.appendRunActivities(owner, chat.id, "run_permission", [{ type: "run.permission_mode", phase: "pending",
      id: permissionModeActivityId("run_permission", "req_raced_mode", "pending"), chatId: chat.id, runId: "run_permission", occurredAt: timestamp,
      clientRequestId: "req_raced_mode", permissionMode: "full_access" }]);
    await repository.finishRun(owner, { chatId: chat.id, runId: "run_permission", outcome: "aborted", completedAt: timestamp });
    const current = await repository.get(owner, chat.id);
    await expect(repository.admitRetry(owner, { chatId: chat.id, turnId: before.turn.id, baseRevision: current!.chat.revision,
      clientRequestId: "req_race_retry", run: { ...before.latestRun, id: "run_retry_race", attempt: 2, status: "accepted" } })).rejects.toThrow();
    expect((await repository.exportChat(owner, chat.id))?.runs).toHaveLength(1);
  });

  it("retains a confirmed Full access change when an unrelated later failure is retried", async () => {
    const { chat } = await admit();
    const active = { owner, chatId: chat.id, controller: new AbortController(), adapter: {
      async setPermissionMode(input: Parameters<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>[0]) {
        await input.begin(); await input.commit();
      },
    } as unknown as CanonicalChatProviderAdapter };
    await setCanonicalPermissionMode({ repository, active }, owner, chat.id, "run_permission", { clientRequestId: "req_confirmed_mode", permissionMode: "full_access" }, { permissionModeProof: "signed" });
    await repository.finishRun(owner, { chatId: chat.id, runId: "run_permission", outcome: "failed", completedAt: timestamp });
    const retry = retryRuntime();
    try {
      const record = await repository.get(owner, chat.id);
      const admitted = await retry.orchestrator.retryTurn({ userId: owner.ownerId, source: "jwt" }, owner, chat.id, "cturn_permission", { clientRequestId: "req_retry_confirmed", baseRevision: record!.chat.revision });
      expect(admitted.run.permissionMode).toBe("full_access");
      await retry.orchestrator.drain(); expect(retry.start).toHaveBeenCalledOnce();
    } finally { await retry.orchestrator.close(); }
  });
});
