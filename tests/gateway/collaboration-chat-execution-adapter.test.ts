import { describe, expect, it, vi } from "vitest";
import type { SharedQueuedTurn } from "../../packages/gateway/src/chat/repository.js";
import type { AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import { collaborationActors, collaborationIds } from "./collaboration-test-support.js";

const now = "2026-09-09T12:00:00.000Z";
const context: AuthorizedCollaborationContext = {
  actorId: collaborationActors.editor,
  ownerId: collaborationActors.owner,
  scopeId: collaborationIds.scope,
  membershipScopeId: collaborationIds.scope,
  resourceKind: "chat",
  resourceId: collaborationIds.chat,
  role: "editor",
  authEpoch: 4,
  authorityRuntimeId: collaborationIds.runtime,
  authorityGeneration: 1,
  capability: "request_ai",
};
const selection = { instanceId: "claude_shared", model: "claude-opus-4-6" };
const queued: SharedQueuedTurn = {
  id: "qturn_shared_adapter_1",
  chatId: collaborationIds.chat,
  scopeId: collaborationIds.scope,
  clientRequestId: "50000000-0000-4000-8000-000000000001",
  requestingActorId: collaborationActors.editor,
  acceptedSequence: 7,
  acceptedAuthEpoch: 4,
  state: "queued",
  parts: [{ type: "text", text: "Summarize this Chat" }],
  selection,
  createdAt: now,
  updatedAt: now,
};

describe("CollaborationChatExecutionAdapter", () => {
  it("admits an attributed request to the canonical queue and wakes dispatch", async () => {
    const enqueueSharedQueuedTurn = vi.fn(async () => ({
      ...queued, pendingCount: 2, alreadyAccepted: false, resourceRevision: 13,
    }));
    const requestDispatch = vi.fn(async () => undefined);
    const onCommitted = vi.fn(async () => undefined);
    const adapter = createAdapter({ enqueueSharedQueuedTurn, requestDispatch, onCommitted });

    await expect(adapter.submit(context, {
      clientRequestId: queued.clientRequestId,
      expectedRevision: "12",
      text: "Summarize this Chat",
      selection,
    })).resolves.toMatchObject({
      resourceRevision: "13",
      request: {
        id: queued.id,
        acceptedSequence: "7",
        actor: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
        state: "queued",
      },
    });
    expect(enqueueSharedQueuedTurn).toHaveBeenCalledWith(
      { type: "personal", ownerId: collaborationActors.owner },
      expect.objectContaining({
        scopeId: collaborationIds.scope,
        requestingActorId: collaborationActors.editor,
        acceptedAuthEpoch: 4,
        expectedRevision: 12,
        driverKind: "claude_code",
      }),
    );
    expect(onCommitted).toHaveBeenCalledWith(collaborationIds.scope);
    await vi.waitFor(() => expect(requestDispatch).toHaveBeenCalledWith(
      collaborationIds.scope,
      collaborationIds.chat,
    ));
  });

  it("does not wake dispatch for an actor-scoped idempotent replay", async () => {
    const requestDispatch = vi.fn(async () => undefined);
    const adapter = createAdapter({
      enqueueSharedQueuedTurn: vi.fn(async () => ({
        ...queued, pendingCount: 2, alreadyAccepted: true, resourceRevision: 13,
      })),
      requestDispatch,
    });
    await adapter.submit(context, {
      clientRequestId: queued.clientRequestId,
      expectedRevision: "12",
      text: "Summarize this Chat",
      selection,
    });
    expect(requestDispatch).not.toHaveBeenCalled();
  });

  it("projects accepted order and private actor identity from server-side resolution", async () => {
    const adapter = createAdapter({ listSharedQueuedTurns: vi.fn(async () => [queued]) });
    await expect(adapter.list({ ...context, capability: "read" })).resolves.toEqual([expect.objectContaining({
      acceptedSequence: "7",
      text: "Summarize this Chat",
      actor: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
    })]);
    await expect(adapter.resourceRevision({ ...context, capability: "read" })).resolves.toBe("13");
  });

  it("projects pending canonical approvals only for runs in the shared queue", async () => {
    const shared = { ...queued, state: "waiting_for_approval" as const, runId: "run_shared" };
    const listSharedPendingApprovals = vi.fn(async () => [{
      runId: "run_shared",
      requestId: queued.id,
      approvalId: "approval_shared",
      title: "Publish release",
      risk: "high" as const,
      allowedDecisions: ["approve" as const, "decline" as const],
    }]);
    const adapter = createAdapter({
      listSharedQueuedTurns: vi.fn(async () => [shared]),
      listSharedPendingApprovals,
    });
    const requests = await adapter.list({ ...context, capability: "read" });

    await expect(adapter.capability({ ...context, capability: "read" }, requests)).resolves.toMatchObject({
      approvals: [{
        approvalId: "approval_shared",
        runId: "run_shared",
        requestId: queued.id,
        title: "Publish release",
        state: "pending",
      }],
    });
    expect(listSharedPendingApprovals).toHaveBeenCalledWith(
      { type: "personal", ownerId: collaborationActors.owner },
      collaborationIds.chat,
      collaborationIds.scope,
    );
  });

  it("forwards attributed controls and refuses a mismatched capability", async () => {
    const cancel = vi.fn(async () => ({ id: "command-1", kind: "cancel" as const, state: "completed" as const }));
    const adapter = createAdapter({ cancel });
    await expect(adapter.cancel(
      { ...context, capability: "control_execution" },
      queued.id,
      { clientRequestId: "50000000-0000-4000-8000-000000000002", expectedRevision: "13" },
    )).resolves.toMatchObject({ kind: "cancel", state: "completed" });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      actorId: collaborationActors.editor,
      requestId: queued.id,
      expectedRevision: 13,
    }));
    await expect(adapter.cancel(context, queued.id, {
      clientRequestId: "50000000-0000-4000-8000-000000000003",
      expectedRevision: "13",
    })).rejects.toMatchObject({ code: "forbidden" });
  });
});

function createAdapter(overrides: Record<string, unknown> = {}) {
  const repository = {
    enqueueSharedQueuedTurn: vi.fn(async () => ({
      ...queued, pendingCount: 1, alreadyAccepted: false, resourceRevision: 13,
    })),
    listSharedQueuedTurns: vi.fn(async () => [queued]),
    listSharedPendingApprovals: vi.fn(async () => []),
    ...pick(overrides, ["enqueueSharedQueuedTurn", "listSharedQueuedTurns", "listSharedPendingApprovals"]),
  };
  const commands = {
    cancel: vi.fn(async () => ({ id: "command-cancel", kind: "cancel" as const, state: "completed" as const })),
    retry: vi.fn(async () => ({ id: "command-retry", kind: "retry" as const, state: "completed" as const })),
    decideApproval: vi.fn(async () => ({ id: "command-approval", kind: "approval" as const, state: "completed" as const })),
    ...pick(overrides, ["cancel", "retry", "decideApproval"]),
  };
  return new CollaborationChatExecutionAdapter({
    repository,
    commands,
    resolveParticipant: async (actorId) => ({ actorId, displayName: "Ada Editor" }),
    resolveResourceRevision: async () => 13,
    resolveEligibility: async () => ({
      profileId: "scope-runtime-chat-v1",
      profileVersion: 1,
      profileDigest: "a".repeat(64),
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    }),
    requestDispatch: (overrides.requestDispatch as (scopeId: string, chatId: string) => Promise<void>)
      ?? (async () => undefined),
    onCommitted: overrides.onCommitted as ((scopeId: string) => Promise<void>) | undefined,
    now: () => new Date(now),
    createQueuedTurnId: () => queued.id,
  });
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => key in source ? [[key, source[key]]] : []));
}
