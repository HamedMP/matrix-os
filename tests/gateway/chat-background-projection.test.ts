import { describe, expect, it, vi } from "vitest";
import { recoverOrphanedRun } from "../../packages/gateway/src/chat/orphaned-run-recovery.js";

describe("background orphan projection", () => {
  it("recovers incremental text without completing an execution that is still running", async () => {
    const appendAssistantDelta = vi.fn().mockResolvedValue(undefined);
    const finishRun = vi.fn();
    const persistActivities = vi.fn();
    const result = await recoverOrphanedRun({
      owner: { type: "personal", ownerId: "owner" },
      run: { id: "run_one", chatId: "chat_one", driverKind: "codex", instanceId: "main" } as never,
      repository: { getAdapterState: vi.fn().mockResolvedValue({ schemaVersion: 1, state: {} }), appendAssistantDelta, finishRun },
      adapter: { stateSchemaVersion: 1, parseState: (v: unknown) => v, recover: async () => ({ outcome: "pending", activities: [{ type: "approval.requested", approvalId: "approval_one", title: "Allow command?", risk: "low", allowedDecisions: ["approve", "decline"] }], messages: [{ messageId: "message_one", text: "partial answer" }] }), isBackingRunActive: async () => true } as never,
      persistActivities,
      messageId: (_run, id) => id!, completedAt: "2026-09-14T00:00:00.000Z",
    });
    expect(result).toBe("pending");
    expect(appendAssistantDelta).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ delta: "partial answer", snapshot: true }));
    expect(finishRun).not.toHaveBeenCalled();
    expect(persistActivities).toHaveBeenCalledWith([expect.objectContaining({ type: "approval.requested", approvalId: "approval_one" })]);
  });
});

import { recoverCodingRun } from "../../packages/gateway/src/chat/coding-run-recovery.js";

it("restores approval and input controls only within the exact interrupted turn", async () => {
  const controls = [
    { type: "approval.requested", approval: { approvalId: "approval_one", title: "Allow command?", risk: "low", allowedDecisions: ["approve", "decline"] } },
    { type: "approval.resolved", approvalId: "approval_one", decision: "approve" },
    { type: "user_input.requested", request: { requestId: "input_one", title: "Choose a target" } },
    { type: "user_input.answered", requestId: "input_one", correlationId: "answer_one" },
  ];
  const read = vi.fn().mockResolvedValue({ thread: { status: "waiting_for_input" }, events: { items: [
    { type: "approval.requested", approval: { approvalId: "stale" } },
    { type: "user.message", clientRequestId: "req_one", eventId: "boundary" }, ...controls,
  ], hasMore: false } });
  const recovered = await recoverCodingRun({ runId: "run_one", state: { conversationId: "thread_one" }, signal: new AbortController().signal, includePending: true, read });
  expect(recovered?.outcome).toBe("pending");
  expect(recovered?.activities).toEqual([
    { type: "approval.requested", ...controls[0].approval },
    controls[1], { type: "input.requested", ...controls[2].request },
    { type: "input.resolved", requestId: "input_one" },
  ]);
});

import { activityPersistenceId } from "../../packages/gateway/src/chat/activity-persistence.js";

it("gives replayed controls stable identities distinct from their resolution and other runs", () => {
  const requested = { type: "approval.requested", approvalId: "approval_one" };
  const id = activityPersistenceId("run_one", requested);
  expect(activityPersistenceId("run_one", { ...requested })).toBe(id);
  expect(activityPersistenceId("run_one", { ...requested, type: "approval.resolved" })).not.toBe(id);
  expect(activityPersistenceId("run_two", requested)).not.toBe(id);
  expect(activityPersistenceId("run_one", { type: "input.requested", requestId: "input_one" })).toBe(activityPersistenceId("run_one", { type: "input.requested", requestId: "input_one" }));
  const resolved = { type: "input.resolved", requestId: "input_one" };
  expect(activityPersistenceId("run_one", resolved)).toBe(activityPersistenceId("run_one", { ...resolved }));
  expect(activityPersistenceId("run_one", resolved)).not.toBe(activityPersistenceId("run_one", { ...resolved, type: "input.requested" }));
});
