import { describe, expect, it } from "vitest";
import { authenticatedApprovalProxyProof } from "../../packages/platform/src/canonical-owner-approval-proxy.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";

const secret = "fixture-platform-only-consent-secret";
const challengeId = `rcact_${"a".repeat(32)}`;
const path = `/api/routine-cli/actions/${challengeId}/decision`;
const value = { actionDigest: "b".repeat(64), decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001" };
const machine = { machineId: "machine_one", handle: "owner-pc", runtimeSlot: "primary", provisioningClass: "customer" as const, clerkUserId: "user_owner" };
const identity = { handle: machine.handle, userId: machine.clerkUserId, runtimeSlot: machine.runtimeSlot, source: "auth" as const };
const clerkAuth = createClerkAuth({ verifyToken: async token => {
  if (token === "real-clerk") return { sub: "user_owner", sid: "sess_owner" };
  if (token === "foreign-clerk") return { sub: "user_foreign", sid: "sess_foreign" };
  if (token === "no-sid") return { sub: "user_owner" };
  throw new Error("Not Clerk");
} });
async function proof(patch: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return authenticatedApprovalProxyProof({ request: new Request(`https://app.example.test/vm/owner-pc${path}`, {
    method: "POST", headers, body: JSON.stringify(value) }), method: "POST", path, identity, machine, handle: machine.handle,
    platformSecret: secret, clerkAuth, ...patch } as Parameters<typeof authenticatedApprovalProxyProof>[0]);
}
describe("routine exact owner purpose at the actual proxy", () => {
  it("mints only from positively verified Clerk session and preserves the exact action digest", async () => {
    expect(await proof({}, { authorization: "Bearer real-clerk" })).toEqual(expect.any(String));
  });
  it("accepts a current signed clerk-browser exchange with explicit expiry", async () => {
    expect(await proof({ identity: { ...identity, sessionProvenance: "clerk-browser", sessionExpiresAt: Math.floor(Date.now() / 1000) + 120 } })).toEqual(expect.any(String));
  });
  it("rejects generic JWT and native-labelled device JWT even after cookie exchange", async () => {
    for (const sessionProvenance of [undefined, "clerk-device", "clerk-browser"]) {
      expect(await proof({ identity: { ...identity, sessionProvenance, verifiedSyncBearer: true } }, {
        authorization: "Bearer device-jwt", "x-matrix-native-client": "matrix-os-desktop", cookie: "matrix_app_session__owner-pc=device-jwt; matrix_native=1",
      })).toBeNull();
    }
  });
  it("rejects wrong owner, absent sid, expired provenance, absent Computer and source capabilities", async () => {
    for (const token of ["foreign-clerk", "no-sid", "rcli_fake", "mcp_fake"]) expect(await proof({}, { authorization: `Bearer ${token}` })).toBeNull();
    expect(await proof({ identity: { ...identity, sessionProvenance: "clerk-browser", sessionExpiresAt: 1 } })).toBeNull();
    expect(await proof({ machine: undefined }, { authorization: "Bearer real-clerk" })).toBeNull();
    expect(await proof({ identity: { ...identity, source: "static-route" } }, { authorization: "Bearer real-clerk" })).toBeNull();
  });
  it("can independently verify a real Clerk cookie when a device cookie/Bearer routes the Computer", async () => {
    expect(await proof({ identity: { ...identity, sessionProvenance: "clerk-device", sessionExpiresAt: Math.floor(Date.now() / 1000) + 120 } }, {
      authorization: "Bearer device-jwt", cookie: "matrix_app_session__owner-pc=device-jwt; __session=real-clerk",
    })).toEqual(expect.any(String));
  });
});
it("a separately verified real Clerk cookie can authorize the selected owned Preview Computer despite generic routing provenance", async () => {
  expect(await proof({ handle: "pr-1234", identity: { ...identity, handle: "pr-1234", runtimeSlot: "pr-1234" }, machine: { ...machine, handle: "pr-1234", runtimeSlot: "pr-1234", provisioningClass: "preview" } }, { authorization: "Bearer device-jwt", cookie: "__session=real-clerk" })).toEqual(expect.any(String));
});
it("caps a fresh Clerk-purpose proof to the verified Clerk token expiry when available", async () => {
  const exp = Math.floor(Date.now() / 1000) + 5;
  const clerk = createClerkAuth({ verifyToken: async () => ({ sub: identity.userId, sid: "session_owner", exp }) });
  const signed = await proof({ clerkAuth: clerk }, { authorization: "Bearer real-clerk" }); expect(signed).toEqual(expect.any(String));
  const payload = JSON.parse(Buffer.from((signed as string).split(".")[0]!, "base64url").toString("utf8"));
  expect(payload.expiresAt).toBeLessThanOrEqual(exp * 1000);
});
