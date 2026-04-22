import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import {
  SYNC_JWT_AUDIENCE,
  validateSyncJwt,
  type JwtKeyConfig,
} from "../../packages/gateway/src/auth-jwt.js";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";
const HANDLE = "alice";

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

function mockContext(path: string, authHeader?: string, ip?: string, url?: string) {
  const store = new Map<string, unknown>();
  return {
    req: {
      path,
      url: url ?? `http://localhost:4000${path}`,
      header: (name: string) => {
        if (name === "Authorization") return authHeader;
        if (name === "X-Forwarded-For" && ip) return ip;
        return undefined;
      },
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  } as any;
}

beforeEach(() => {
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.MATRIX_HANDLE = HANDLE;
});

afterEach(() => {
  delete process.env.PLATFORM_JWT_SECRET;
  delete process.env.PLATFORM_JWT_PUBLIC_KEY;
  delete process.env.MATRIX_HANDLE;
});

describe("validateSyncJwt", () => {
  const keyConfig: JwtKeyConfig = { secret: JWT_SECRET };

  it("accepts a valid JWT issued for this gateway's handle", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
    });
    const claims = await validateSyncJwt(issued.token, {
      ...keyConfig,
      expectedHandle: HANDLE,
    });
    expect(claims.sub).toBe("user_alice");
  });

  it("rejects a JWT issued for a different handle", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: "bob",
      gatewayUrl: "https://bob.matrix-os.com",
    });
    await expect(
      validateSyncJwt(issued.token, { ...keyConfig, expectedHandle: HANDLE }),
    ).rejects.toThrow();
  });

  it("rejects an expired JWT", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
      now: 1_000,
      expiresInSec: 60,
    });
    await expect(
      validateSyncJwt(issued.token, {
        ...keyConfig,
        expectedHandle: HANDLE,
        now: 2_000,
      }),
    ).rejects.toThrow();
  });

  it("rejects a JWT signed with a different key", async () => {
    const issued = await issueSyncJwt({
      secret: "completely-different-secret-32-char!!",
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
    });
    await expect(
      validateSyncJwt(issued.token, { ...keyConfig, expectedHandle: HANDLE }),
    ).rejects.toThrow();
  });

  it("rejects HS256 tokens when verifying with a configured public key", async () => {
    const { publicKey } = await generateKeyPair("RS256");
    const token = signHs256Jwt({
      sub: "user_alice",
      handle: HANDLE,
      gateway_url: "https://alice.matrix-os.com",
      aud: SYNC_JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "matrix-os-platform",
    }, new TextEncoder().encode("fake-public-key-material"));

    await expect(
      validateSyncJwt(token, { publicKey, expectedHandle: HANDLE }),
    ).rejects.toThrow();
  });

  it("accepts an RS256 token when configured with a PEM public key", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const pem = await exportSPKI(publicKey);
    process.env.PLATFORM_JWT_PUBLIC_KEY = pem;
    delete process.env.PLATFORM_JWT_SECRET;

    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "user_alice",
      handle: HANDLE,
      gateway_url: "https://alice.matrix-os.com",
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer("matrix-os-platform")
      .setAudience(SYNC_JWT_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    await mw(
      mockContext("/api/message", `Bearer ${token}`),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });
});

describe("authMiddleware: hybrid bearer + JWT acceptance", () => {
  it("accepts a valid sync JWT issued for this handle", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
    });

    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    await mw(
      mockContext("/api/message", `Bearer ${issued.token}`),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("accepts a valid sync JWT in the websocket query string", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://app.matrix-os.com",
    });

    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    await mw(
      mockContext(
        "/ws/terminal",
        undefined,
        undefined,
        `http://localhost:4000/ws/terminal?token=${encodeURIComponent(issued.token)}&cwd=projects`,
      ),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects a JWT issued for a different handle (cross-tenant defense)", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_bob",
      handle: "bob",
      gatewayUrl: "https://bob.matrix-os.com",
    });

    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    const res = await mw(
      mockContext("/api/message", `Bearer ${issued.token}`, "10.0.0.1"),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res?.status).toBe(401);
  });

  it("still accepts the legacy MATRIX_AUTH_TOKEN bearer secret", async () => {
    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    await mw(
      mockContext("/api/message", "Bearer legacy-shared-secret"),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects an arbitrary string that is neither the legacy token nor a valid JWT", async () => {
    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    const res = await mw(
      mockContext("/api/message", "Bearer not-a-jwt-and-not-the-secret", "10.0.0.2"),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res?.status).toBe(401);
  });

  it("rejects an expired JWT", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
      now: 1_000,
      expiresInSec: 60,
    });

    // Wait so the JWT is past expiry. The middleware should reject without
    // a fresh "now" override -- jose uses the system clock.
    const mw = authMiddleware("legacy-shared-secret");
    let nextCalled = false;
    const res = await mw(
      mockContext("/api/message", `Bearer ${issued.token}`, "10.0.0.3"),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res?.status).toBe(401);
  });

  it("does not fall back to legacy bearer auth after JWT validation fails", async () => {
    const issued = await issueSyncJwt({
      secret: "completely-different-secret-32-char!!",
      clerkUserId: "user_alice",
      handle: HANDLE,
      gatewayUrl: "https://alice.matrix-os.com",
    });

    const mw = authMiddleware(issued.token);
    let nextCalled = false;
    const res = await mw(
      mockContext("/api/message", `Bearer ${issued.token}`, "10.0.0.4"),
      async () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(false);
    expect(res?.status).toBe(401);
  });
});
