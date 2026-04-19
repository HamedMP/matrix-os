import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { getUserIdFromContext } from "../../../packages/gateway/src/auth.js";
import { issueSyncJwt } from "../../../packages/platform/src/sync-jwt.js";
import {
  createSyncRoutes,
  type SyncRouteDeps,
} from "../../../packages/gateway/src/sync/routes.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long";
const HANDLE = "alice";
const CLERK_USER_ID = "user_2abc123xyz";

const mockR2 = {
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getPresignedGetUrl: vi.fn(),
  getPresignedPutUrl: vi.fn(),
  destroy: vi.fn(),
};

const mockDb = {
  getManifestMeta: vi.fn(),
  upsertManifestMeta: vi.fn(),
  withAdvisoryLock: vi.fn(),
};

const mockPeerRegistry = {
  registerPeer: vi.fn(),
  removePeer: vi.fn(),
  broadcastChange: vi.fn(),
  sendToUser: vi.fn(),
  getPeers: vi.fn(() => []),
};

const mockSharing = {
  createShare: vi.fn(),
  acceptShare: vi.fn(),
  revokeShare: vi.fn(),
  listShares: vi.fn(),
  checkSharePermission: vi.fn(),
};

function buildApp(getUserId: (c: any) => string) {
  const deps: SyncRouteDeps = {
    r2: mockR2 as any,
    db: mockDb as any,
    peerRegistry: mockPeerRegistry as any,
    sharing: mockSharing as any,
    getUserId,
    getPeerId: () => "test-peer",
  };
  const app = new Hono();
  app.use("*", authMiddleware(process.env.MATRIX_AUTH_TOKEN));
  app.route("/api/sync", createSyncRoutes(deps));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_JWT_SECRET = JWT_SECRET;
  process.env.MATRIX_AUTH_TOKEN = "legacy-shared-secret";
  process.env.MATRIX_HANDLE = HANDLE;

  const manifest = { version: 2, files: {} };
  const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
  mockR2.getObject.mockResolvedValue({ body, etag: '"etag-abc"' });
  mockDb.getManifestMeta.mockResolvedValue({ version: 1, etag: '"etag-abc"' });
});

afterEach(() => {
  delete process.env.PLATFORM_JWT_SECRET;
  delete process.env.PLATFORM_JWT_PUBLIC_KEY;
  delete process.env.MATRIX_AUTH_TOKEN;
  delete process.env.MATRIX_HANDLE;
});

describe("getUserIdFromContext (helper)", () => {
  it("returns claims.sub when JWT claims are present on the context", () => {
    const ctx = {
      get: (key: string) =>
        key === "jwtClaims"
          ? { sub: CLERK_USER_ID, handle: HANDLE, gateway_url: "https://app" }
          : undefined,
    } as any;
    expect(getUserIdFromContext(ctx)).toBe(CLERK_USER_ID);
  });

  it("falls back to MATRIX_HANDLE when no JWT claims are set", () => {
    const ctx = { get: () => undefined } as any;
    expect(getUserIdFromContext(ctx)).toBe(HANDLE);
  });

  it('falls back to "default" when neither claims nor MATRIX_HANDLE are set', () => {
    delete process.env.MATRIX_HANDLE;
    const ctx = { get: () => undefined } as any;
    expect(getUserIdFromContext(ctx)).toBe("default");
  });

  it("treats an empty claims.sub as missing and falls back to MATRIX_HANDLE", () => {
    // Defense-in-depth: an empty string in `sub` must not silently become
    // the R2 prefix. `validateSyncJwt` should reject these at the gate,
    // but the helper must also refuse to use a zero-length user id.
    const ctx = {
      get: (key: string) =>
        key === "jwtClaims"
          ? { sub: "", handle: HANDLE, gateway_url: "https://app" }
          : undefined,
    } as any;
    expect(getUserIdFromContext(ctx)).toBe(HANDLE);
  });
});

describe("sync routes: userId resolution from JWT", () => {
  it("GET /api/sync/manifest uses claims.sub (Clerk userId) for R2 key lookup", async () => {
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: CLERK_USER_ID,
      handle: HANDLE,
      gatewayUrl: "https://app.matrix-os.com",
    });

    const app = buildApp(getUserIdFromContext);
    const res = await app.request("/api/sync/manifest", {
      headers: { Authorization: `Bearer ${issued.token}` },
    });

    expect(res.status).toBe(200);

    // R2 key for the manifest is `matrixos-sync/${userId}/manifest.json`.
    // With a JWT present, `userId` must be the Clerk sub, NOT the handle.
    expect(mockR2.getObject).toHaveBeenCalled();
    const key = mockR2.getObject.mock.calls[0][0] as string;
    expect(key).toBe(`matrixos-sync/${CLERK_USER_ID}/manifest.json`);
    expect(key).not.toContain(`/${HANDLE}/`);

    // ManifestDb metadata row is keyed by the same user id.
    expect(mockDb.getManifestMeta).toHaveBeenCalledWith(CLERK_USER_ID);
  });

  it("GET /api/sync/manifest falls back to MATRIX_HANDLE when legacy bearer is used (no JWT)", async () => {
    const app = buildApp(getUserIdFromContext);
    const res = await app.request("/api/sync/manifest", {
      headers: { Authorization: "Bearer legacy-shared-secret" },
    });

    expect(res.status).toBe(200);
    const key = mockR2.getObject.mock.calls[0][0] as string;
    expect(key).toBe(`matrixos-sync/${HANDLE}/manifest.json`);
    expect(mockDb.getManifestMeta).toHaveBeenCalledWith(HANDLE);
  });

  it("tampered JWT falls through to legacy bearer path and uses MATRIX_HANDLE", async () => {
    // A JWT whose signature no longer matches must NOT be treated as a
    // valid Clerk identity. `authMiddleware` falls through to the legacy
    // bearer check — with the legacy secret presented separately, we
    // wouldn't get in; so this case sends ONLY the tampered JWT and
    // asserts a 401. The second half of the case then sends the legacy
    // secret and asserts we get in under MATRIX_HANDLE (proving the
    // tampered JWT didn't silently stash forged claims on the context).
    const issued = await issueSyncJwt({
      secret: JWT_SECRET,
      clerkUserId: CLERK_USER_ID,
      handle: HANDLE,
      gatewayUrl: "https://app.matrix-os.com",
    });
    // Flip the last character of the signature segment. Base64url uses
    // [A-Za-z0-9_-]; swap 'A' ↔ 'B' so the token still *looks* like a JWT
    // (3 base64url segments) and reaches the validator.
    const parts = issued.token.split(".");
    const sig = parts[2]!;
    const lastChar = sig.slice(-1);
    const flipped = lastChar === "A" ? "B" : "A";
    const tamperedToken = `${parts[0]}.${parts[1]}.${sig.slice(0, -1)}${flipped}`;

    const app = buildApp(getUserIdFromContext);

    // 1. Tampered JWT alone → 401 (JWT path fails, legacy path can't match).
    const deniedRes = await app.request("/api/sync/manifest", {
      headers: {
        Authorization: `Bearer ${tamperedToken}`,
        "X-Forwarded-For": "10.0.0.99",
      },
    });
    expect(deniedRes.status).toBe(401);

    // 2. Legitimate legacy bearer still lands under MATRIX_HANDLE — the
    //    tampered JWT didn't poison the shared `authMiddleware` state.
    const res = await app.request("/api/sync/manifest", {
      headers: { Authorization: "Bearer legacy-shared-secret" },
    });
    expect(res.status).toBe(200);
    const key = mockR2.getObject.mock.calls[0][0] as string;
    expect(key).toBe(`matrixos-sync/${HANDLE}/manifest.json`);
  });
});
