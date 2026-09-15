import { afterEach, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";

const owner = { type: "personal" as const, ownerId: "read_recovery_owner" };
const now = "2026-09-06T13:19:34.000Z";
let repository: ChatRepository;
afterEach(async () => { await repository?.kysely.destroy(); });

async function setup(adapters: any[] = []) {
  const db = await KyselyPGlite.create();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: "chat_recovery", title: "Recovery", clientRequestId: "req_create_recovery" });
  await repository.admitTurn(owner, {
    chatId: "chat_recovery", baseRevision: 0,
    message: { id: "msg_recovery", chatId: "chat_recovery", seq: 1, role: "user", state: "committed", turnId: "cturn_recovery", parts: [{ type: "text", text: "read files" }], createdAt: now },
    turn: { id: "cturn_recovery", chatId: "chat_recovery", clientRequestId: "req_turn_recovery", baseMessageSeq: 0, inputMessageId: "msg_recovery", status: "accepted", createdAt: now, updatedAt: now },
    run: { id: "run_recovery", chatId: "chat_recovery", turnId: "cturn_recovery", attempt: 1, driverKind: "codex", instanceId: "codex_default", selection: { instanceId: "codex_default", model: "test" }, interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0, capabilitySnapshot: { revision: "test", rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [], approvals: true, userInput: true, worktrees: "optional", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: now, updatedAt: now },
  });
  const orchestrator = new CanonicalChatOrchestrator({ repository, adapters: new CanonicalChatProviderRegistry(adapters), catalog: { getCatalog: async () => { throw new Error("Recovery must not run a provider"); } } });
  return { orchestrator, service: createCanonicalChatService(repository, { orchestrator }) };
}

it.each(["detail", "list", "search"])("clears orphaned Working state on %s without sending a prompt", async (surface) => {
  const { service } = await setup();
  if (surface === "list") await service.list(owner, { limit: 20 });
  if (surface === "search") await service.search(owner, { query: "Recovery", limit: 20 });
  const detail = surface === "detail"
    ? await service.getDetail(owner, "chat_recovery", { limit: 200 })
    : await repository.getDetailPage(owner, "chat_recovery", { limit: 200 });
  expect(detail?.runs[0]?.status).toBe("failed");
  expect(detail?.messages[0]?.parts).toEqual([{ type: "text", text: "read files" }]);
});

it("reconciles orphaned runs before event replay on reconnect", async () => {
  const { orchestrator } = await setup();
  const stream = createCanonicalChatEventStream({ repository, reconcileOwner: owner => orchestrator.reconcileActiveRuns(owner) });
  const frames: any[] = [];
  const session = await stream.open({ principal: { userId: owner.ownerId, source: "jwt" }, sink: { send: frame => { frames.push(frame); return true; }, close() {} } });
  expect((await repository.getDetailPage(owner, "chat_recovery", { limit: 200 }))?.runs[0]?.status).toBe("failed");
  expect(frames.some(frame => frame.type === "chat.event" && frame.event.eventType === "run.failed")).toBe(true);
  session.onClose();
  stream.shutdown();
});


it("restores approval submission and confirmed stop from durable background identity", async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const submitApproval = vi.fn().mockResolvedValue(undefined);
  const provider = { driverKind: "codex", stateSchemaVersion: 1, detachOnShutdown: true,
    parseState: (state: unknown) => state, cancel, submitApproval,
    recover: async () => ({ outcome: "pending", messages: [], activities: [{ type: "approval.requested", approvalId: "appr_recovered", title: "Allow?", risk: "low", allowedDecisions: ["approve"] }] }),
  };
  const { orchestrator } = await setup([provider]);
  await repository.markRunRunning(owner, { chatId: "chat_recovery", runId: "run_recovery", startedAt: now });
  await repository.updateAdapterState(owner, { chatId: "chat_recovery", runId: "run_recovery", driverKind: "codex", instanceId: "codex_default", schemaVersion: 1, state: { conversationId: "thread_recovered" } });
  await orchestrator.reconcileActiveRuns(owner);
  await orchestrator.reconcileActiveRuns(owner);
  const before = await repository.exportChat(owner, "chat_recovery");
  expect(before?.activities.filter(activity => activity.type === "approval.requested")).toHaveLength(1);
  await orchestrator.submitApproval(owner, "chat_recovery", "run_recovery", "appr_recovered", { clientRequestId: "req_approve_recovered", decision: "approve" });
  expect(submitApproval).toHaveBeenCalledWith(expect.objectContaining({ state: { conversationId: "thread_recovered" } }));
  cancel.mockRejectedValueOnce(new Error("stop unconfirmed"));
  await expect(orchestrator.cancelRun(owner, "chat_recovery", "run_recovery")).rejects.toThrow();
  expect((await repository.exportChat(owner, "chat_recovery"))?.runs[0]?.status).toBe("waiting_for_approval");
  await orchestrator.cancelRun(owner, "chat_recovery", "run_recovery");
  expect(cancel).toHaveBeenCalledTimes(2);
  expect((await repository.exportChat(owner, "chat_recovery"))?.runs[0]?.status).toBe("aborted");
});
