import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createKernelChatProviderAdapter } from "../../packages/gateway/src/chat/kernel-provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "retired_owner" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const selection = { instanceId: "kernel_matrix_included", model: "claude-sonnet-5" };
const timestamp = "2026-10-02T00:00:00.000Z";
const capabilitySnapshot = {
  revision: "legacy_catalog", rootChat: true, resume: true, cancellation: true,
  steering: "none" as const, attachments: [], tools: [], approvals: false, userInput: false,
  worktrees: "none" as const, resources: [], interactionModes: ["default"], permissionModes: ["full_access"],
};
const catalog = CanonicalProviderCatalogSchema.parse({ revision: "retired_catalog", drivers: [], instances: [] });

describe("historical Matrix SDK Chat retirement", () => {
  let repository: ChatRepository;
  beforeEach(async () => {
    const database = await KyselyPGlite.create();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
    await repository.create(owner, { id: "chat_old", clientRequestId: "req_create_old", title: "Old SDK Chat" });
    await repository.admitTurn(owner, {
      chatId: "chat_old", baseRevision: 0,
      message: { id: "msg_old", chatId: "chat_old", seq: 1, role: "user", state: "committed", turnId: "cturn_old", parts: [{ type: "text", text: "Historical prompt" }], createdAt: timestamp },
      turn: { id: "cturn_old", chatId: "chat_old", clientRequestId: "req_old", baseMessageSeq: 0, inputMessageId: "msg_old", status: "accepted", createdAt: timestamp, updatedAt: timestamp },
      run: { id: "run_old", chatId: "chat_old", turnId: "cturn_old", attempt: 1, driverKind: "kernel", instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "full_access", status: "accepted", historyBoundarySeq: 0, capabilitySnapshot, createdAt: timestamp, updatedAt: timestamp },
    });
    await repository.updateAdapterState(owner, { chatId: "chat_old", runId: "run_old", driverKind: "kernel", instanceId: selection.instanceId, schemaVersion: 1, state: { sessionId: "opaque_sdk_session" } });
  });
  afterEach(async () => repository.kysely.destroy());

  function orchestrator(dispatch = vi.fn(async () => {})) {
    return { dispatch, runtime: new CanonicalChatOrchestrator({ repository, catalog: { getCatalog: async () => catalog }, adapters: new CanonicalChatProviderRegistry([createKernelChatProviderAdapter({ dispatcher: { dispatch } })]) }) };
  }

  it("keeps records and checkpoint readable while rejecting new turns and retry without rebinding", async () => {
    await repository.finishRun(owner, { chatId: "chat_old", runId: "run_old", outcome: "failed", completedAt: timestamp });
    const before = await repository.exportChat(owner, "chat_old");
    const { runtime, dispatch } = orchestrator();
    const record = await repository.get(owner, "chat_old");
    await expect(runtime.admitTurn(principal, owner, "chat_old", { clientRequestId: "req_follow", baseRevision: record!.chat.revision, selection, parts: [{ type: "text", text: "Continue" }], interactionMode: "default", permissionMode: "full_access" })).rejects.toMatchObject({ safeError: { recoveryActions: ["start_new_chat"] } });
    await expect(runtime.retryTurn(principal, owner, "chat_old", "cturn_old", { clientRequestId: "req_retry", baseRevision: record!.chat.revision })).rejects.toMatchObject({ safeError: { recoveryActions: ["start_new_chat"] } });
    expect(await repository.exportChat(owner, "chat_old")).toEqual(before);
    expect(await repository.getAdapterState(owner, { runId: "run_old", driverKind: "kernel", instanceId: selection.instanceId })).toMatchObject({ state: { sessionId: "opaque_sdk_session" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("blocks a persisted pre-upgrade queue after restart at the adapter boundary", async () => {
    await repository.enqueueQueuedTurn(owner, { chatId: "chat_old", baseRevision: 1, queuedTurnId: "qturn_old", clientRequestId: "req_queue_old", parts: [{ type: "text", text: "Queued prompt" }], driverKind: "kernel", selection, interactionMode: "default", permissionMode: "full_access", capabilitySnapshot, createdAt: timestamp });
    await repository.finishRun(owner, { chatId: "chat_old", runId: "run_old", outcome: "failed", completedAt: timestamp });
    const { runtime, dispatch } = orchestrator();
    await runtime.reconcileActiveRuns(owner);
    await runtime.drain();
    const exported = await repository.exportChat(owner, "chat_old");
    expect(exported?.runs).toHaveLength(2);
    expect(exported?.runs[1]).toMatchObject({ driverKind: "kernel", instanceId: selection.instanceId, status: "failed" });
    expect(exported?.activities).toContainEqual(expect.objectContaining({ type: "run.error", error: expect.objectContaining({ recoveryActions: ["start_new_chat"] }) }));
    expect(exported?.chat).toMatchObject({ providerBinding: { driverKind: "kernel", instanceId: selection.instanceId } });
    expect(await repository.getAdapterState(owner, { runId: "run_old", driverKind: "kernel", instanceId: selection.instanceId })).toMatchObject({ state: { sessionId: "opaque_sdk_session" } });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
