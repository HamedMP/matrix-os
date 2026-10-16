import { describe, expect, it } from "vitest";
import type { CanonicalChatRunActivity } from "@matrix-os/contracts";
import { selectPendingApproval } from "../../packages/gateway/src/chat/pending-approval.js";

const requested = {
  id: "activity_request", chatId: "chat_1", runId: "run_1", occurredAt: "2026-10-16T00:00:00.000Z",
  type: "approval.requested", approvalId: "approval_1", title: "Search the web", risk: "low",
  allowedDecisions: ["approve", "approve_for_session", "decline", "cancel"],
} as const satisfies CanonicalChatRunActivity;

describe("selectPendingApproval", () => {
  it("keeps an unanswered request open to every offered decision", () => {
    expect(selectPendingApproval([requested], "approval_1")).toEqual(requested);
  });

  it("closes a request after a one-time decision", () => {
    expect(selectPendingApproval([
      requested,
      { ...requested, id: "activity_resolved", type: "approval.resolved", decision: "approve" },
    ], "approval_1")).toBeNull();
  });

  it("leaves a chat grant revocable by decline until Undo records session_revoked", () => {
    const granted = selectPendingApproval([
      requested,
      { ...requested, id: "activity_resolved", type: "approval.resolved", decision: "approve_for_session" },
    ], "approval_1");
    expect(granted?.allowedDecisions).toEqual(["decline"]);
    expect(selectPendingApproval([
      requested,
      { ...requested, id: "activity_resolved", type: "approval.resolved", decision: "approve_for_session" },
      { ...requested, id: "activity_resolved", type: "approval.resolved", decision: "approve_for_session", reason: "session_revoked" },
    ], "approval_1")).toBeNull();
  });
});
