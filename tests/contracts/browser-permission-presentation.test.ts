import { expect, it } from "vitest";
import { canonicalChatApprovals, type CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat.js";

function fixture() {
  const { snapshot } = createCanonicalChatFixture("approval_required");
  const run = snapshot.runs[0]!;
  const lifecycle = { kind: "shared_chrome" as const, leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0,
    scopeVersion: 1 as const, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const requested = { id: "activity_browser", chatId: run.chatId, runId: run.id, occurredAt: run.updatedAt,
    type: "approval.requested" as const, approvalId: "browser_one", title: "Use Matrix Browser", safeDescription: "Use this Chrome profile.",
    actionDigest: "a".repeat(64), risk: "medium" as const, allowedDecisions: ["approve", "decline", "cancel"], browserApproval: lifecycle };
  return { detail: { ...snapshot, activities: [requested] } as unknown as CanonicalChatDetailResponse, requested, lifecycle, run };
}
it("retains exact browser scope in the shared approval projection", () => {
  const s = fixture();
  expect(canonicalChatApprovals(s.detail)[0]).toMatchObject({ pending: true, actionDigest: "a".repeat(64), browserApproval: s.lifecycle });
});
it("never offers stale approval controls after the browser challenge expires", () => {
  const s = fixture(); s.lifecycle.expiresAt = new Date(Date.now() - 1000).toISOString();
  expect(canonicalChatApprovals(s.detail)[0]).toMatchObject({ pending: false, browserApproval: { resolution: "expired" } });
});
it("preserves the recorded scope and grant separately from a generic native approval", () => {
  const s = fixture();
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: s.run.chatId, capability: "shared_chrome" as const,
    scopeVersion: 1 as const, revision: 1, state: "active" as const, createdAt: new Date().toISOString(), revokedAt: null };
  s.detail.activities.push({ ...s.requested, id: "activity_browser_resolved", type: "approval.resolved", decision: "approve",
    browserApproval: { ...s.lifecycle, resolution: "allowed_in_chat" }, browserGrant: grant } as never);
  expect(canonicalChatApprovals(s.detail)[0]).toMatchObject({ pending: false, decision: "approve", browserApproval: { resolution: "allowed_in_chat" }, browserGrant: grant });
});

it("builds distinct browser choices with the exact challenge and refuses stale requests", async () => {
  const { browserPermissionRequest } = await import("@matrix-os/contracts");
  const s = fixture(); const approval = canonicalChatApprovals(s.detail)[0]!;
  const once = browserPermissionRequest(approval, "allow_once", "req_once");
  const chat = browserPermissionRequest(approval, "allow_in_chat", "req_chat");
  expect(once).toMatchObject({ decision: "approve", actionDigest: s.requested.actionDigest, browserApproval: { decision: "allow_once", leaseEpoch: s.lifecycle.leaseEpoch } });
  expect(chat.browserApproval?.decision).toBe("allow_in_chat");
  expect(browserPermissionRequest(approval, "not_now", "req_no").decision).toBe("decline");
  expect(() => browserPermissionRequest(approval, "allow_once", "req_old", Date.now() + 90_000)).toThrow("Approval unavailable");
  expect(() => browserPermissionRequest(undefined, "allow_once", "req_missing")).toThrow();
});
