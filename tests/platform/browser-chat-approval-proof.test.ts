import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticatedApprovalProxyProof } from "../../packages/platform/src/session-routing-middleware.js";
import { mintCustomMcpApprovalProof, verifyCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";

const platformSecret = "synthetic-platform-browser-proof-key-not-a-machine-bearer";
const handle = "pr-1234";
const path = "/api/chats/chat_browser/runs/run_browser/approvals/browser_exact_call";
const identity = { handle, userId: "user_browser", runtimeSlot: handle, source: "auth" as const,
  sessionProvenance: "clerk-browser" as const };
const machine = { handle, runtimeSlot: handle, provisioningClass: "preview" as const };
const leaseEpoch = "178ca19d-9760-4e67-a221-62bedf393b90";
const actionDigest = "a".repeat(64);

/** The real bounded proxy boundary signs a distinct browser decision. Its
 * original two positive cases established semantic RED before implementation.
 */
function body(browserDecision: "allow_once" | "allow_in_chat") {
  return { clientRequestId: `req_${browserDecision}`, decision: "approve", actionDigest,
    browserApproval: { kind: "shared_chrome", decision: browserDecision, leaseEpoch,
      challengeRevision: 0, scopeVersion: 1 } };
}
async function proxyProof(value: unknown, overrides: Partial<Parameters<typeof authenticatedApprovalProxyProof>[0]> = {}) {
  return authenticatedApprovalProxyProof({
    request: new Request(`https://app.example.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }),
    method: "POST", path, handle, identity, machine, platformSecret, browserApprovalsEnabled: true, ...overrides,
  });
}

describe("authenticated browser decision proof contract (layer A)", () => {
  it.each(["allow_once", "allow_in_chat"] as const)("signs explicit %s with owner, Chat, Run, epoch and exact-action binding in a separate domain", async browserDecision => {
    const requestBody = body(browserDecision);
    const proof = await proxyProof(requestBody);
    expect(proof, "Verified owner browser decisions need a distinct platform proof; a host-only permission card is insufficient").toEqual(expect.any(String));
    const [encoded, signature] = (proof as string).split(".");
    expect(signature).toBe(createHmac("sha256", platformSecret)
      .update(`matrix-browser-user-decision:v1\0${encoded}`).digest("hex"));
    const payload = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ version: 1, handle, actorId: identity.userId, runtimeSlot: handle,
      chatId: "chat_browser", runId: "run_browser", approvalId: "browser_exact_call",
      clientRequestId: requestBody.clientRequestId, browserDecision, actionDigest, leaseEpoch,
      challengeRevision: 0, scopeVersion: 1 });
    expect(payload.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(payload.expiresAt).toBeGreaterThan(Date.now());
    expect(payload.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(verifyCustomMcpApprovalProof(proof as string, { handle, actorId: identity.userId,
      chatId: "chat_browser", runId: "run_browser", approvalId: "browser_exact_call",
      clientRequestId: requestBody.clientRequestId, decision: "approve", actionDigest, secret: platformSecret })).toBe(false);
  });

  it("does not mint a browser decision from a machine marker, missing provenance, expired session or unsupported identity source", async () => {
    for (const patch of [
      { sessionProvenance: undefined, verifiedSyncBearer: true },
      { sessionProvenance: undefined, verifiedSyncBearer: false },
      { source: "static-route" as const },
      { source: "mobile-session" as const },
      { sessionExpiresAt: Math.floor(Date.now() / 1000) - 1 },
    ]) expect(await proxyProof(body("allow_in_chat"), { identity: { ...identity, ...patch } })).toBeNull();
  });

  it("does not convert a generic/native session approval into a browser Chat grant", async () => {
    expect(await proxyProof({ clientRequestId: "req_native_session", decision: "approve_for_session", actionDigest,
      browserApproval: { kind: "shared_chrome", decision: "allow_in_chat", leaseEpoch, challengeRevision: 0, scopeVersion: 1 } })).toBeNull();
    expect(await proxyProof({ ...body("allow_once"), browserApproval: { ...body("allow_once").browserApproval, decision: "approve_for_session" } })).toBeNull();
  });

  it("keeps browser authority disabled until explicitly enabled", async () => {
    expect(await proxyProof(body("allow_once"), { browserApprovalsEnabled: false })).toBeNull();
  });

  it("preserves existing integration proof semantics and domain", () => {
    const value = { clientRequestId: "req_integration", decision: "approve" };
    const proof = mintCustomMcpApprovalProof({ method: "POST", path, identity, body: JSON.stringify(value), secret: platformSecret });
    expect(verifyCustomMcpApprovalProof(proof!, { handle, actorId: identity.userId, chatId: "chat_browser", runId: "run_browser",
      approvalId: "browser_exact_call", clientRequestId: value.clientRequestId, decision: "approve", secret: platformSecret })).toBe(true);
    const [encoded, signature] = proof!.split(".");
    expect(signature).not.toBe(createHmac("sha256", platformSecret)
      .update(`matrix-browser-user-decision:v1\0${encoded}`).digest("hex"));
  });
});
