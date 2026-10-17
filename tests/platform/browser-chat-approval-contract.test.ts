import { describe, expect, it } from "vitest";
import { CanonicalSubmitChatApprovalRequestSchema } from "@matrix-os/contracts";

const browserApproval = { kind: "shared_chrome", decision: "allow_once", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 };
const request = { clientRequestId: "req_browser", decision: "approve", actionDigest: "a".repeat(64), browserApproval };
describe("typed browser owner approval submission", () => {
  it("admits explicit one-call and Chat-only scope without changing native session decisions", () => {
    expect(CanonicalSubmitChatApprovalRequestSchema.safeParse(request).success).toBe(true);
    expect(CanonicalSubmitChatApprovalRequestSchema.safeParse({ ...request, browserApproval: { ...browserApproval, decision: "allow_in_chat" } }).success).toBe(true);
    expect(CanonicalSubmitChatApprovalRequestSchema.safeParse({ clientRequestId: "req_legacy", decision: "approve_for_session" }).success).toBe(true);
  });
  it("rejects scope mismatches, missing exact digest, bad epochs/revisions and unknown authority fields", () => {
    for (const patch of [{ decision: "approve_for_session" }, { decision: "decline" }, { actionDigest: undefined },
      { browserApproval: { ...browserApproval, decision: "approve_for_session" } }, { browserApproval: { ...browserApproval, leaseEpoch: "forged" } },
      { browserApproval: { ...browserApproval, challengeRevision: -1 } }, { browserApproval: { ...browserApproval, ownerId: "foreign" } }]) {
      expect(CanonicalSubmitChatApprovalRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
});
