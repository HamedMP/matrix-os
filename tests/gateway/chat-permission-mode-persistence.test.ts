import { createChatRoutineSourceProducer } from "../../packages/gateway/src/chat/routine-chat-source.js";
import { routineActionPolicy } from "../../packages/gateway/src/bots/routine-action-source-registry.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
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

  it("reloads the acknowledged effective mode while retaining admission capabilities", async () => {
    const { chat, snapshot } = await admit();
    await repository.appendRunActivities(owner, chat.id, "run_permission", [{
      id: "activity_permission", chatId: chat.id, runId: "run_permission", occurredAt: timestamp,
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
      await input.commit();
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
    const control = vi.fn<NonNullable<CanonicalChatProviderAdapter["setPermissionMode"]>>(async input => { await input.commit(); });
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
      await repository.appendRunActivities(owner, chat.id, "run_permission", [{ type: "run.permission_mode", id: `activity_routine_mode_${index}`,
        chatId: chat.id, runId: "run_permission", occurredAt: timestamp, clientRequestId: `req_routine_mode_${index}`, permissionMode }]);
      expect(await valid()).toBe(true);
      const policy = source.producer.readPolicy();
      expect(policy.originCeiling).toBe("exact");
      expect(routineActionPolicy(source.producer.source, policy, "control")).toBe("ask");
    }
    await repository.kysely.updateTable("chat_runs").set({ permission_mode: "auto" }).where("id", "=", "run_permission").execute();
    expect(await valid()).toBe(false);
  });
});
