import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthRoutes } from "../../packages/platform/src/auth-routes.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";

const JWT_SECRET = "test-support-secret-at-least-32-characters-long";
const SIGNING_SECRET = "provider-generated-support-signing-secret";

function app(secret?: string) {
  // Support proofs depend on the validated principal and server configuration, not the DB.
  const db = new Proxy({} as PlatformDB, {
    get() { throw new Error("Support identity must not access the database"); },
  });
  return createAuthRoutes({ db, jwtSecret: JWT_SECRET, platformUrl: "https://app.matrix-os.com",
    gatewayUrlForHandle: () => "https://app.matrix-os.com", supportIdentitySecret: secret });
}

async function auth() {
  const issued = await issueSyncJwt({ secret: JWT_SECRET, clerkUserId: "user_alice", handle: "alice",
    gatewayUrl: "https://app.matrix-os.com" });
  return { authorization: `Bearer ${issued.token}` };
}

describe("Support identity route", () => {
  it.each([SIGNING_SECRET, `${SIGNING_SECRET}\n`, ` \t${SIGNING_SECRET}\r\n`])(
    "signs with the provider key independently of surrounding configuration whitespace", async secret => {
      const response = await app(secret).request("/api/support/identity?distinctId=user_mallory", { headers: await auth() });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "verified", distinctId: "user_alice",
        identityHash: createHmac("sha256", SIGNING_SECRET).update("user_alice").digest("hex") });
    },
  );

  it.each([undefined, "", " \t\r\n"])("returns unavailable for an empty signing configuration", async secret => {
    const response = await app(secret).request("/api/support/identity", { headers: await auth() });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("rejects missing and invalid authentication before signing", async () => {
    for (const headers of [undefined, { authorization: "Bearer invalid-token" }]) {
      const response = await app(SIGNING_SECRET).request("/api/support/identity", { headers });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });
});
