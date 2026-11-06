import { SignJWT, jwtVerify } from "jose";
import { createClerkAuth } from "../../../packages/platform/src/clerk-auth.js";
import { authenticatedApprovalProxyProof } from "../../../packages/platform/src/canonical-owner-approval-proxy.js";
import { createRoutineOriginVerificationRoutes } from "../../../packages/platform/src/routine-origin-proof-routes.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { createRoutineOriginPlatformClient } from "../../../packages/gateway/src/bots/routine-origin-platform-client.js";

/** Real JWT verification/HMAC/proxy/internal Hono; all keys and machine/account records are isolated fixtures. */
export function routineOriginBrowserFixture(ownerId: string) {
  const secret = "fixture-origin-composition-signing-key";
  const key = new TextEncoder().encode("fixture-origin-browser-jwt-key-at-least-32-bytes");
  const machine = { machineId: "machine_origin_fixture", handle: "computer-one", runtimeSlot: "primary",
    clerkUserId: ownerId, provisioningClass: "customer" as const, status: "running" as const };
  const clerkAuth = createClerkAuth({ verifyToken: async token => {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: "fixture-clerk" });
    return { ...payload, sub: payload.sub! };
  } });
  const internal = createRoutineOriginVerificationRoutes({ platformSecret: secret,
    lookup: { resolveMachine: async () => machine } });
  const client = createRoutineOriginPlatformClient({ platformUrl: "https://purpose.fixture.test", handle: machine.handle,
    token: buildPlatformVerificationToken(machine.handle, secret), fetcher: async (url, init) => internal.fetch(new Request(url, init)) });
  return { machine, client,
    async proof(sourceChatId: string, interactionId: string, body: object) {
      const token = await new SignJWT({ sid: "sess_origin_composition" }).setProtectedHeader({ alg: "HS256" })
        .setSubject(ownerId).setIssuer("fixture-clerk").setExpirationTime("2m").sign(key);
      const path = `/api/chats/${sourceChatId}/routine-origin/${interactionId}/resolve`;
      const proof = await authenticatedApprovalProxyProof({ request: new Request(`https://app.fixture.test${path}`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }),
      method: "POST", path, handle: machine.handle, identity: { source: "auth", userId: ownerId,
        handle: machine.handle, runtimeSlot: machine.runtimeSlot }, machine, clerkAuth, platformSecret: secret });
      if (typeof proof !== "string") throw new Error("Fixture browser decision was not attested");
      return proof;
    } };
}
