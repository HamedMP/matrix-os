import { describe, expect, it, vi } from "vitest";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority.js";
import {
  createSharedAiApprovalReconciler,
  createSharedAiCancellationDispatcher,
} from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
describe("shared AI runtime cancellation", () => {
  it("reauthorizes the actor immediately before stopping the external run", async () => {
    const policy = { getM2: vi.fn(async () => ({
      milestone: "m2" as const,
      mode: "enabled" as const,
      cohort: [],
      issuedAt: "2026-09-10T00:00:00.000Z",
      expiresAt: "2026-09-10T01:00:00.000Z",
      keyId: "key-1",
      signature: "signature",
    })) };
    const authorize = vi.fn()
      .mockResolvedValueOnce({
        scopeId: "10000000-0000-4000-8000-000000000001",
        actorId: "user_editor",
        ownerId: "user_owner",
        resourceKind: "chat",
        resourceId: "chat_shared",
      })
      .mockRejectedValueOnce(new CollaborationAuthorizationError("not_found", "revoked"));
    const cancelSharedRun = vi.fn(async () => undefined);
    const dispatch = createSharedAiCancellationDispatcher({
      policy,
      authority: { authorize },
      orchestrator: { cancelSharedRun },
    });
    const input = {
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_shared",
      runId: "run_shared",
      requestId: "qturn_shared",
      clientRequestId: "50000000-0000-4000-8000-000000000001",
      actorId: "user_editor",
    };
    await expect(dispatch(input)).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: input.scopeId,
      actorId: input.actorId,
      action: "control_execution",
    }));
    expect(cancelSharedRun).toHaveBeenCalledWith(
      { type: "personal", ownerId: "user_owner" },
      input.scopeId,
      input.chatId,
      input.runId,
    );
    await expect(dispatch(input)).rejects.toMatchObject({ code: "not_found" });
    expect(cancelSharedRun).toHaveBeenCalledTimes(1);
  });
  it("interrupts and terminally reconciles an approval with an unknown outcome", async () => {
    const cancelSharedRun = vi.fn(async () => { throw new Error("runtime disconnected"); });
    const reconcileActiveRuns = vi.fn(async () => 1);
    const reconcile = createSharedAiApprovalReconciler({
      resolveOwnerId: vi.fn(async () => "user_owner"),
      readRunStatus: vi.fn(async () => "failed" as const),
      orchestrator: { cancelSharedRun, reconcileActiveRuns },
    });
    await expect(reconcile({
      commandId: "10000000-0000-4000-8000-000000000009",
      scopeId: "10000000-0000-4000-8000-000000000001",
      chatId: "chat_shared",
      runId: "run_shared",
      approvalId: "approval_shared",
      decision: "approve",
    })).resolves.toBe("failed");
    expect(cancelSharedRun).toHaveBeenCalledOnce();
    expect(reconcileActiveRuns).toHaveBeenCalledWith({ type: "personal", ownerId: "user_owner" });
  });
});
