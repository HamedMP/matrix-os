import { describe, expect, it } from "vitest";
import { mintBrowserApprovalProof, verifyBrowserDecisionProof, verifyBrowserRevokeProof } from "../../packages/platform/src/browser-chat-approval-proof.js";
import { createBrowserChatApprovalRoutes } from "../../packages/platform/src/browser-chat-approval-routes.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { createBrowserApprovalPlatformClient } from "../../packages/gateway/src/chat/browser-approval-platform-client.js";
import { BrowserApprovalMachineLookup } from "../../packages/platform/src/browser-approval-machine-lookup.js";

const secret = "synthetic-owner-platform-key";
const identity = { handle: "pr-1234", runtimeSlot: "pr-1234", userId: "owner_browser", source: "auth" as const, sessionProvenance: "clerk-device" as const };
const tuple = { handle: identity.handle, runtimeSlot: identity.runtimeSlot, actorId: identity.userId, chatId: "chat_one", runId: "run_one",
  approvalId: "browser_one", clientRequestId: "req_one", browserDecision: "allow_once" as const, actionDigest: "a".repeat(64),
  leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 as const };
function proof() { return mintBrowserApprovalProof({ method: "POST", path: "/api/chats/chat_one/runs/run_one/approvals/browser_one", identity, secret,
  body: JSON.stringify({ clientRequestId: tuple.clientRequestId, decision: "approve", actionDigest: tuple.actionDigest,
    browserApproval: { kind: "shared_chrome", decision: tuple.browserDecision, leaseEpoch: tuple.leaseEpoch, challengeRevision: 0, scopeVersion: 1 } }) })!; }
function lookup(owner = identity.userId) {
  return new BrowserApprovalMachineLookup({ databaseUrl: "postgresql://synthetic.invalid/platform", poolFactory: (() => ({
    connect: async () => ({ query: async () => ({ rows: [{ clerk_user_id: owner, runtime_slot: identity.runtimeSlot, status: "running" }] }), release() {} }),
    on() {}, end: async () => {},
  })) as never });
}
describe("browser platform authority", () => {
  it("rejects changed exact tuple, host-known key, expiry and wrong signature domain", () => {
    const signed = proof();
    expect(verifyBrowserDecisionProof(signed, tuple, secret)).toMatchObject(tuple);
    for (const patch of [{ actorId: "foreign" }, { handle: "pr-9999" }, { runtimeSlot: "primary" }, { chatId: "other_chat" },
      { runId: "other_run" }, { approvalId: "other_approval" }, { clientRequestId: "other_request" }, { browserDecision: "allow_in_chat" as const },
      { actionDigest: "b".repeat(64) }, { leaseEpoch: "278ca19d-9760-4e67-a221-62bedf393b90" }, { challengeRevision: 1 }]) {
      expect(verifyBrowserDecisionProof(signed, { ...tuple, ...patch }, secret)).toBeNull();
    }
    expect(verifyBrowserDecisionProof(signed, tuple, buildPlatformVerificationToken(identity.handle, secret))).toBeNull();
    expect(verifyBrowserDecisionProof(signed, tuple, secret, Date.now() + 61_000)).toBeNull();
    expect(verifyBrowserDecisionProof(`${signed}x`, tuple, secret)).toBeNull();
  });
  it("binds Undo to a separate revoke domain and exact grant/revision", () => {
    const grantId = "278ca19d-9760-4e67-a221-62bedf393b90";
    const signed = mintBrowserApprovalProof({ method: "DELETE", path: `/api/chats/chat_one/browser-grants/${grantId}`, identity, secret,
      body: JSON.stringify({ clientRequestId: "req_undo", baseRevision: 2 }) })!;
    const revoke = { handle: identity.handle, actorId: identity.userId, runtimeSlot: identity.runtimeSlot, chatId: "chat_one", grantId, clientRequestId: "req_undo", baseRevision: 2 };
    expect(verifyBrowserRevokeProof(signed, revoke, secret)).toMatchObject(revoke);
    expect(verifyBrowserRevokeProof(signed, { ...revoke, baseRevision: 3 }, secret)).toBeNull();
    expect(verifyBrowserDecisionProof(signed, tuple, secret)).toBeNull();
  });
  it("requires both machine transport and independently signed current owner intent across the Gateway client", async () => {
    const owned = lookup();
    const app = createBrowserChatApprovalRoutes({ enabled: true, platformSecret: secret, lookup: owned });
    const token = buildPlatformVerificationToken(identity.handle, secret);
    const client = createBrowserApprovalPlatformClient({ platformUrl: "https://platform.example.test", handle: identity.handle, token,
      fetcher: (url, init) => app.request(String(url), init) });
    expect(await client.verifyDecision(tuple, proof())).toMatchObject(tuple);
    await expect(client.verifyDecision(tuple, "machine-only")).rejects.toThrow("Browser approval unavailable");
    const disabled = createBrowserChatApprovalRoutes({ enabled: false, platformSecret: secret });
    expect((await disabled.request(`/internal/containers/${identity.handle}/browser-approvals/verify`, { method: "POST" })).status).toBe(404);
    const other = lookup("other_owner");
    const wrongOwner = createBrowserChatApprovalRoutes({ enabled: true, platformSecret: secret, lookup: other });
    expect((await wrongOwner.request(`/internal/containers/${identity.handle}/browser-approvals/verify`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "x-matrix-browser-approval-proof": proof() }, body: JSON.stringify({ kind: "decision", tuple }) })).status).toBe(403);
    await owned.close(); await other.close();
  });
});
