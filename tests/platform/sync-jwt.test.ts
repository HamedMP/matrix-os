import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { generateKeyPair } from "jose";
import {
  SYNC_JWT_AUDIENCE,
  issueSyncJwt,
  verifySyncJwt,
  SYNC_JWT_ISSUER,
} from "../../packages/platform/src/sync-jwt.js";

function base64UrlEncode(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signHs256Jwt(
  claims: Record<string, string | number>,
  secretBytes: Uint8Array,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", Buffer.from(secretBytes))
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

const SECRET = "test-secret-at-least-32-characters-long";

describe("sync-jwt: issuance", () => {
  it("issues a JWT with the expected claims", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
      now: 1_700_000_000,
    });

    expect(issued.token.split(".")).toHaveLength(3);
    expect(issued.claims).toMatchObject({
      sub: "user_abc",
      handle: "alice",
      gateway_url: "https://alice.matrix-os.com",
      aud: SYNC_JWT_AUDIENCE,
      iss: SYNC_JWT_ISSUER,
      iat: 1_700_000_000,
    });
    expect(issued.claims.exp).toBeGreaterThan(issued.claims.iat);
  });

  it("defaults expiresInSec to 24 hours", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
      now: 1_700_000_000,
    });

    const oneDay = 24 * 60 * 60;
    expect(issued.claims.exp - issued.claims.iat).toBe(oneDay);
    expect(issued.expiresAt).toBe((1_700_000_000 + oneDay) * 1000);
  });
});

describe("sync-jwt: verification", () => {
  it("verifies a valid token issued with the same secret", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });

    const claims = await verifySyncJwt(issued.token, { secret: SECRET });
    expect(claims.sub).toBe("user_abc");
    expect(claims.handle).toBe("alice");
  });

  it("rejects a token signed with a different secret", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });

    await expect(
      verifySyncJwt(issued.token, { secret: "different-secret-also-32-chars-long!!" }),
    ).rejects.toThrow();
  });

  it("rejects HS256 tokens when verifying with a configured public key", async () => {
    const { publicKey } = await generateKeyPair("RS256");
    const token = signHs256Jwt({
      sub: "user_abc",
      handle: "alice",
      gateway_url: "https://alice.matrix-os.com",
      aud: SYNC_JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: SYNC_JWT_ISSUER,
    }, new TextEncoder().encode("fake-public-key-material"));

    await expect(
      verifySyncJwt(token, { publicKey }),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
      now: 1_000,
      expiresInSec: 60,
    });

    await expect(
      verifySyncJwt(issued.token, { secret: SECRET, now: 2_000 }),
    ).rejects.toThrow();
  });

  it("rejects a token whose handle does not match expectedHandle", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });

    await expect(
      verifySyncJwt(issued.token, {
        secret: SECRET,
        expectedHandle: "bob",
      }),
    ).rejects.toThrow();
  });

  it("accepts a token whose handle matches expectedHandle", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });

    const claims = await verifySyncJwt(issued.token, {
      secret: SECRET,
      expectedHandle: "alice",
    });
    expect(claims.handle).toBe("alice");
  });

  it("rejects a token with a tampered payload", async () => {
    const issued = await issueSyncJwt({
      secret: SECRET,
      clerkUserId: "user_abc",
      handle: "alice",
      gatewayUrl: "https://alice.matrix-os.com",
    });

    const [header, , signature] = issued.token.split(".");
    const evilPayload = Buffer.from(
      JSON.stringify({
        sub: "user_abc",
        handle: "evil",
        gateway_url: "https://evil.example",
        iat: 1,
        exp: 9_999_999_999,
        iss: SYNC_JWT_ISSUER,
      }),
    )
      .toString("base64url");
    const tampered = `${header}.${evilPayload}.${signature}`;

    await expect(
      verifySyncJwt(tampered, { secret: SECRET }),
    ).rejects.toThrow();
  });
});
