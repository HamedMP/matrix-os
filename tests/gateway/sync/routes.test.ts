import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  ShareNotFoundError,
  ShareSelfError,
  ShareDuplicateError,
  ShareForbiddenError,
  GranteeNotFoundError,
  ShareInvalidPathError,
} from "../../../packages/gateway/src/sync/sharing.js";

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);

// Mock dependencies
const mockR2 = {
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getPresignedGetUrl: vi.fn(),
  getPresignedPutUrl: vi.fn(),
  createMultipartUpload: vi.fn(),
  getPresignedPartUrl: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  destroy: vi.fn(),
};

const mockDb = {
  getManifestMeta: vi.fn(),
  getAggregateManifestStats: vi.fn(),
  upsertManifestMeta: vi.fn(),
  advanceManifestMeta: vi.fn().mockResolvedValue(true),
  withAdvisoryLock: vi.fn(),
};

const mockPeerRegistry = {
  registerPeer: vi.fn(),
  removePeer: vi.fn(),
  broadcastChange: vi.fn(),
  sendToUser: vi.fn(),
  getPeers: vi.fn(),
  getTotalPeerCount: vi.fn(),
};

const mockSharing = {
  createShare: vi.fn(),
  acceptShare: vi.fn(),
  revokeShare: vi.fn(),
  listShares: vi.fn(),
};

import {
  createSyncRoutes,
  createUnconfiguredSyncRoutes,
  type SyncRouteDeps,
} from "../../../packages/gateway/src/sync/routes.js";

function createTestApp(overrides?: Partial<SyncRouteDeps>) {
  const deps: SyncRouteDeps = {
    r2: mockR2,
    db: mockDb as any,
    peerRegistry: mockPeerRegistry,
    sharing: mockSharing,
    getUserId: () => "test-user",
    getPeerId: () => "test-peer",
    finalizeStagedObject: vi.fn(async ({ expectedHash }) => ({
      objectKey: `matrixos-sync/test-user/objects/sha256/${expectedHash.slice("sha256:".length)}`,
    })),
    ...overrides,
  };
  const syncApp = createSyncRoutes(deps);
  const app = new Hono();
  app.route("/api/sync", syncApp);
  return app;
}

function jsonRequest(path: string, body?: unknown, method = "POST") {
  const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) {
    let payload = body;
    if (body && typeof body === "object" && (
      path === "/api/sync/presign"
      || path === "/api/sync/commit"
      || path.startsWith("/api/sync/multipart/")
    )) {
      payload = { ...body as Record<string, unknown>, protocolVersion: 3 };
      if (path === "/api/sync/commit" && Array.isArray((payload as { files?: unknown }).files)) {
        payload = {
          ...payload as Record<string, unknown>,
          files: ((payload as { files: Array<Record<string, unknown>> }).files).map((file) => (
            file.action === "delete"
              ? file
              : { stagingId: "11111111-1111-4111-8111-111111111111", ...file }
          )),
        };
      }
      if (path.startsWith("/api/sync/multipart/")) {
        payload = {
          stagingId: "11111111-1111-4111-8111-111111111111",
          ...payload as Record<string, unknown>,
        };
      }
    }
    init.body = JSON.stringify(payload);
  }
  return new Request(`http://localhost${path}`, init);
}

describe("GET /api/sync/manifest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns manifest with version and etag", async () => {
    const manifest = { version: 2, files: { "test.txt": { hash: HASH_A, size: 100, mtime: 1000, peerId: "p1", version: 1 } } };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"etag-123"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 5, etag: '"etag-123"' });

    const app = createTestApp();
    const res = await app.request("/api/sync/manifest");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.manifest.version).toBe(2);
    expect(json.manifestVersion).toBe(5);
    expect(json.etag).toBe('"etag-123"');
    expect(res.headers.get("ETag")).toBe('"etag-123"');
  });

  it("returns empty manifest when none exists", async () => {
    mockR2.getObject.mockRejectedValue(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
    mockDb.getManifestMeta.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request("/api/sync/manifest");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.manifest.version).toBe(2);
    expect(Object.keys(json.manifest.files)).toHaveLength(0);
    expect(json.manifestVersion).toBe(0);
  });

  it("returns 304 when If-None-Match matches ETag", async () => {
    const manifest = { version: 2, files: {} };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"etag-123"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 3, etag: '"etag-123"' });

    const app = createTestApp();
    const res = await app.request("/api/sync/manifest", {
      headers: { "If-None-Match": '"etag-123"' },
    });

    expect(res.status).toBe(304);
  });
});

describe("POST /api/sync/presign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockR2.getPresignedGetUrl.mockResolvedValue("https://r2.example.com/get");
    mockR2.getPresignedPutUrl.mockResolvedValue("https://r2.example.com/put");
    mockR2.getObject.mockResolvedValue({
      body: {
        text: async () => JSON.stringify({
          version: 2,
          files: Object.fromEntries([
            "readme.md",
            "download.txt",
            "notes/studio.md",
          ].map((path) => [path, {
            hash: HASH_A,
            size: 1,
            mtime: 1,
            peerId: "peer",
            version: 1,
          }])),
        }),
      },
      etag: '"manifest"',
    });
    mockDb.getManifestMeta.mockResolvedValue(null);
  });

  it("returns presigned URLs for valid files", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "readme.md", action: "get" }],
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.urls).toHaveLength(1);
    expect(json.urls[0].path).toBe("readme.md");
    expect(json.urls[0].url).toBe("https://r2.example.com/get");
    expect(json.urls[0].expiresIn).toBe(900);
  });

  it("requires the immutable-publication protocol before issuing upload URLs", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "legacy.txt", action: "put", hash: HASH_A, size: 1 }],
      }),
    });

    expect(res.status).toBe(426);
    await expect(res.json()).resolves.toEqual({
      error: "sync_upgrade_required",
      requiredProtocolVersion: 3,
    });
    expect(mockR2.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  it("returns 400 for empty files array", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [],
    }));

    expect(res.status).toBe(400);
  });

  it("returns 400 for path traversal attempt", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "../etc/passwd", action: "get" }],
    }));

    expect(res.status).toBe(400);
  });

  it("returns 500 when R2 signing fails with a message that happens to mention path", async () => {
    mockR2.getPresignedGetUrl.mockRejectedValueOnce(new Error("upstream path lookup failed"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "readme.md", action: "get" }],
    }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "Presign generation failed",
    });
  });

  it("handles batch of mixed GET and PUT", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [
        { path: "download.txt", action: "get" },
        { path: "upload.txt", action: "put", hash: HASH_A, size: 100 },
      ],
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.urls).toHaveLength(2);
  });

  it("uses the trusted runtime scope for non-primary object keys", async () => {
    mockR2.getPresignedGetUrl.mockResolvedValue("https://r2.example/get");
    const app = createTestApp({
      getUserId: undefined,
      getScope: () => ({ ownerId: "test-user", runtimeSlot: "studio" }),
    });

    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "notes/studio.md", action: "get" }],
    }));

    expect(res.status).toBe(200);
    expect(mockR2.getPresignedGetUrl).toHaveBeenCalledWith(
      "matrixos-sync/v2/owners/test-user/runtimes/studio/files/notes/studio.md",
      900,
    );
  });

  it("accepts PUT files with zero size", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "upload.txt", action: "put", hash: HASH_A, size: 0 }],
    }));

    expect(res.status).toBe(200);
    expect(mockR2.getPresignedPutUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^matrixos-sync\/test-user\/staging\/[0-9a-f-]{36}$/),
      0,
      900,
    );
  });

  it("returns 429 when rate limit exceeded", async () => {
    // Each createTestApp creates its own rate limiter instance (100 req/min)
    const app = createTestApp();

    // Send 100 requests (at limit)
    for (let i = 0; i < 100; i++) {
      const res = await app.request(jsonRequest("/api/sync/presign", {
        files: [{ path: `file-${i}.txt`, action: "put", hash: HASH_A, size: 1 }],
      }));
      expect(res.status).toBe(200);
    }

    // 101st should be rate limited
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "one-too-many.txt", action: "put", hash: HASH_A, size: 1 }],
    }));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toMatch(/rate limit/i);
  });

  it("returns 400 for invalid JSON", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON" });
  });
});

describe("POST /api/sync/multipart/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockR2.completeMultipartUpload.mockResolvedValue({ etag: '"complete-etag"' });
  });

  it("completes a multipart upload inside the authenticated user prefix", async () => {
    const app = createTestApp();

    const res = await app.request(jsonRequest("/api/sync/multipart/complete", {
      path: "videos/large.mov",
      uploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: '"complete-etag"' });
    expect(mockR2.completeMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/test-user/staging/11111111-1111-4111-8111-111111111111",
      "upload-123",
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
  });

  it("requires protocol 3 before completing a legacy live-path upload", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "videos/legacy.mov",
        uploadId: "upload-legacy",
        parts: [{ partNumber: 1, etag: '"etag"' }],
      }),
    });

    expect(res.status).toBe(426);
    expect(mockR2.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("rejects invalid complete payloads before calling storage", async () => {
    const app = createTestApp();

    const res = await app.request(jsonRequest("/api/sync/multipart/complete", {
      path: "../large.mov",
      uploadId: "upload-123",
      parts: [{ partNumber: 1, etag: '"etag-1"' }],
    }));

    expect(res.status).toBe(400);
    expect(mockR2.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("rejects duplicate multipart part numbers before calling storage", async () => {
    const app = createTestApp();

    const res = await app.request(jsonRequest("/api/sync/multipart/complete", {
      path: "videos/large.mov",
      uploadId: "upload-123",
      parts: [
        { partNumber: 1, etag: '"etag-1a"' },
        { partNumber: 1, etag: '"etag-1b"' },
      ],
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Validation error" });
    expect(mockR2.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("accepts complete bodies over the shared mutating limit within the multipart cap", async () => {
    const app = createTestApp();
    const parts = Array.from({ length: 140 }, (_, index) => ({
      partNumber: index + 1,
      etag: `"${String(index + 1).padStart(5, "0")}-${"e".repeat(490)}"`,
    }));
    const body = JSON.stringify({
      protocolVersion: 3,
      path: "videos/large.mov",
      stagingId: "11111111-1111-4111-8111-111111111111",
      uploadId: "upload-123",
      parts,
    });

    expect(Buffer.byteLength(body)).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);

    const res = await app.request("/api/sync/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: '"complete-etag"' });
    expect(mockR2.completeMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/test-user/staging/11111111-1111-4111-8111-111111111111",
      "upload-123",
      parts,
    );
  });

  it("does not consume the commit rate-limit bucket", async () => {
    const app = createTestApp();

    for (let index = 0; index < 100; index += 1) {
      const res = await app.request(jsonRequest("/api/sync/multipart/complete", {
        path: `videos/large-${index}.mov`,
        uploadId: `upload-${index}`,
        parts: [{ partNumber: 1, etag: `"etag-${index}"` }],
      }));
      expect(res.status).toBe(200);
    }

    const res = await app.request("/api/sync/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON" });
  });
});

describe("POST /api/sync/multipart/abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockR2.abortMultipartUpload.mockResolvedValue(undefined);
  });

  it("aborts a multipart upload inside the authenticated user prefix", async () => {
    const app = createTestApp();

    const res = await app.request(jsonRequest("/api/sync/multipart/abort", {
      path: "videos/large.mov",
      uploadId: "upload-123",
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockR2.abortMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/test-user/staging/11111111-1111-4111-8111-111111111111",
      "upload-123",
    );
  });

  it("does not block cleanup after the commit bucket is exhausted", async () => {
    const app = createTestApp();

    for (let index = 0; index < 100; index += 1) {
      const res = await app.request("/api/sync/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(res.status).toBe(400);
    }

    const res = await app.request(jsonRequest("/api/sync/multipart/abort", {
      path: "videos/large.mov",
      uploadId: "upload-123",
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockR2.abortMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/test-user/staging/11111111-1111-4111-8111-111111111111",
      "upload-123",
    );
  });
});

describe("POST /api/sync/commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.withAdvisoryLock.mockImplementation(async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(undefined));
  });

  it("commits files and returns new version", async () => {
    const manifest = { version: 2, files: {} };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e1"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e1"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/commit", {
      files: [{ path: "new.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 0,
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.manifestVersion).toBe(1);
    expect(json.committed).toBe(1);
  });

  it("rejects legacy commits with an actionable upgrade response", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "legacy.txt", hash: HASH_A, size: 1 }],
        expectedVersion: 0,
      }),
    });

    expect(res.status).toBe(426);
    await expect(res.json()).resolves.toEqual({
      error: "sync_upgrade_required",
      requiredProtocolVersion: 3,
    });
    expect(mockDb.withAdvisoryLock).not.toHaveBeenCalled();
  });

  it("returns 409 on version conflict", async () => {
    mockDb.getManifestMeta.mockResolvedValue({ version: 5, etag: '"e"' });

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/commit", {
      files: [{ path: "test.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 3,
    }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("version_conflict");
    expect(json.currentVersion).toBe(5);
  });

  it("broadcasts sync:change via peer registry", async () => {
    const manifest = { version: 2, files: {} };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const app = createTestApp();
    await app.request(jsonRequest("/api/sync/commit", {
      files: [{ path: "changed.txt", hash: HASH_A, size: 50 }],
      expectedVersion: 0,
    }));

    expect(mockPeerRegistry.broadcastChange).toHaveBeenCalledWith(
      "test-user", expect.any(String), expect.objectContaining({ type: "sync:change" }),
    );
  });

  it("returns 400 for invalid request body", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/commit", {
      files: [],
      expectedVersion: 0,
    }));

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON" });
  });
});

describe("GET /api/sync/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns sync status with connected peers", async () => {
    mockPeerRegistry.getPeers.mockReturnValue([
      { peerId: "p1", userId: "test-user", hostname: "laptop", platform: "darwin", clientVersion: "0.1.0", connectedAt: 1000 },
    ]);
    mockPeerRegistry.getTotalPeerCount.mockReturnValue(9);
    mockDb.getManifestMeta.mockResolvedValue({ version: 5, file_count: 100, total_size: 50000n, etag: '"e"', updated_at: new Date(2000) });
    mockDb.getAggregateManifestStats.mockResolvedValue({ fileCount: 500, totalSize: 99999n });

    const app = createTestApp({
      getHomeMirrorStatus: () => ({ state: "ready" }),
    });
    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connectedPeers).toHaveLength(1);
    expect(json.connectedPeers[0].peerId).toBe("p1");
    expect(json.manifestVersion).toBe(5);
    expect(json.fileCount).toBe(100);
    expect(json.homeMirror).toEqual({ state: "ready" });
    expect(mockPeerRegistry.getTotalPeerCount).toHaveBeenCalledTimes(1);
    expect(mockDb.getAggregateManifestStats).toHaveBeenCalledTimes(1);
  });

  it("returns defaults when no manifest metadata exists", async () => {
    mockPeerRegistry.getPeers.mockReturnValue([]);
    mockDb.getManifestMeta.mockResolvedValue(null);

    const app = createTestApp();
    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connectedPeers).toEqual([]);
    expect(json.manifestVersion).toBe(0);
    expect(json.fileCount).toBe(0);
    expect(json.totalSize).toBe(0);
    expect(json.homeMirror).toEqual({ state: "disabled" });
  });

  it("reports a coarse failed home-mirror state without exposing internal errors", async () => {
    mockPeerRegistry.getPeers.mockReturnValue([]);
    mockDb.getManifestMeta.mockResolvedValue(null);

    const app = createTestApp({
      getHomeMirrorStatus: () => ({ state: "failed" }),
    });
    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.homeMirror).toEqual({ state: "failed" });
    expect(JSON.stringify(json)).not.toContain("error");
  });

  it("reports failed readiness when sync infrastructure is unavailable", async () => {
    const app = new Hono();
    app.route("/api/sync", createUnconfiguredSyncRoutes({
      getHomeMirrorStatus: () => ({ state: "failed" }),
    }));

    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Not configured",
      homeMirror: { state: "failed" },
    });
  });
});

describe("DELETE /api/sync/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects oversized bodies with 413", async () => {
    const app = createTestApp();
    const body = JSON.stringify({ shareId: "a".repeat(100_000) });

    const res = await app.request("/api/sync/share", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });

    expect(res.status).toBe(413);
  });

  it("returns 400 for invalid JSON", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/share", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid JSON" });
  });

  it("returns 400 when shareId is not a UUID", async () => {
    const app = createTestApp();
    const res = await app.request("/api/sync/share", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shareId: "not-a-uuid" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/sync/resolve-conflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.withAdvisoryLock.mockImplementation(async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(undefined));
    mockDb.getManifestMeta.mockResolvedValue({
      version: 2,
      file_count: 1,
      total_size: 100n,
      etag: '"etag-1"',
      updated_at: new Date(),
    });
    mockR2.getObject.mockResolvedValue({
      body: {
        text: () => Promise.resolve(JSON.stringify({
          version: 2,
          manifestVersion: 2,
          files: {
            "readme (conflict - peer1 - 2026-04-14).md": {
              hash: HASH_A,
              size: 12,
              mtime: 1000,
              peerId: "peer1",
              version: 1,
            },
          },
        })),
      },
      etag: '"etag-1"',
    });
    mockR2.putObject.mockResolvedValue({ etag: '"etag-2"' });
  });

  it("resolves a conflict and returns success", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "readme.md",
      resolution: "keep-local",
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resolved).toBe(true);
  });

  it("returns 400 for invalid resolution type", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "readme.md",
      resolution: "invalid-option",
    }));

    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid path even when conflictPath is valid", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "../escape.txt",
      resolution: "keep-local",
      conflictPath: "readme (conflict - peer1 - 2026-04-14).md",
    }));

    expect(res.status).toBe(400);
    expect(mockR2.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes conflict copy from R2 when conflictPath is provided", async () => {
    mockR2.deleteObject.mockResolvedValue(undefined);

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "readme.md",
      resolution: "keep-local",
      conflictPath: "readme (conflict - peer1 - 2026-04-14).md",
    }));

    expect(res.status).toBe(200);
    expect(mockR2.putObject).toHaveBeenCalledTimes(1);
    expect(mockR2.deleteObject).toHaveBeenCalledWith(
      "matrixos-sync/test-user/files/readme (conflict - peer1 - 2026-04-14).md",
    );
    expect(mockPeerRegistry.broadcastChange).toHaveBeenCalledWith(
      "test-user",
      "test-peer",
      expect.objectContaining({
        type: "sync:change",
        manifestVersion: 3,
      }),
    );
  });

  it("logs and continues when deleting the conflict copy from R2 fails after the manifest update", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockR2.deleteObject.mockRejectedValue(new Error("r2 unavailable"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "readme.md",
      resolution: "keep-local",
      conflictPath: "readme (conflict - peer1 - 2026-04-14).md",
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });
    expect(warnSpy).toHaveBeenCalledWith(
      "[sync/resolve-conflict] Failed to delete orphaned conflict blob after manifest update:",
      "r2 unavailable",
    );
  });
});

describe("sharing routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST /share creates a share and returns 201", async () => {
    mockSharing.createShare.mockResolvedValue({
      shareId: "uuid-1",
      path: "projects/",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor",
    });

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor",
    }));

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.shareId).toBe("uuid-1");
  });

  it("POST /share returns 400 for invalid body", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {}));
    expect(res.status).toBe(400);
  });

  it("POST /share returns a generic 400 when grantee resolution fails", async () => {
    mockSharing.createShare.mockRejectedValue(new GranteeNotFoundError("@nobody:matrix-os.com"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/",
      granteeHandle: "@nobody:matrix-os.com",
      role: "viewer",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Share request could not be created" });
  });

  it("POST /share returns 400 on self-share", async () => {
    mockSharing.createShare.mockRejectedValue(new ShareSelfError());

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/",
      granteeHandle: "@me:matrix-os.com",
      role: "editor",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Cannot share with self" });
  });

  it("POST /share returns 400 with a generic invalid path message", async () => {
    mockSharing.createShare.mockRejectedValue(new ShareInvalidPathError("../../../etc"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "../../../etc",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid share path" });
  });

  it("POST /share returns a generic 400 on duplicate", async () => {
    mockSharing.createShare.mockRejectedValue(new ShareDuplicateError());

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/startup/",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor",
    }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Share request could not be created" });
  });

  it("POST /share rejects invalid Matrix handles before hitting the service", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/",
      granteeHandle: "not-a-matrix-id",
      role: "editor",
    }));

    expect(res.status).toBe(400);
    expect(mockSharing.createShare).not.toHaveBeenCalled();
  });

  it("GET /shares returns 429 when rate limit exceeded", async () => {
    mockSharing.listShares.mockResolvedValue({ owned: [], received: [] });
    const app = createTestApp();

    for (let i = 0; i < 60; i++) {
      const res = await app.request("/api/sync/shares");
      expect(res.status).toBe(200);
    }

    const res = await app.request("/api/sync/shares");
    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "Rate limit exceeded" });
  });

  it("DELETE /share revokes and returns 200", async () => {
    mockSharing.revokeShare.mockResolvedValue(undefined);

    const app = createTestApp();
    const res = await app.request(new Request("http://localhost/api/sync/share", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: "550e8400-e29b-41d4-a716-446655440000" }),
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revoked).toBe(true);
  });

  it("DELETE /share returns 400 when shareId missing", async () => {
    const app = createTestApp();
    const res = await app.request(new Request("http://localhost/api/sync/share", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(res.status).toBe(400);
  });

  it("DELETE /share returns 404 when share not found", async () => {
    mockSharing.revokeShare.mockRejectedValue(new ShareNotFoundError("nonexistent"));

    const app = createTestApp();
    const res = await app.request(new Request("http://localhost/api/sync/share", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: "550e8400-e29b-41d4-a716-446655440001" }),
    }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Share not found" });
  });

  it("DELETE /share returns 403 when caller is not owner", async () => {
    mockSharing.revokeShare.mockRejectedValue(new ShareForbiddenError("Not the owner"));

    const app = createTestApp();
    const res = await app.request(new Request("http://localhost/api/sync/share", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareId: "550e8400-e29b-41d4-a716-446655440002" }),
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("POST /share/accept returns 400 for invalid body", async () => {
    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share/accept", {}));
    expect(res.status).toBe(400);
  });

  it("POST /share/accept returns 200 on success", async () => {
    mockSharing.acceptShare.mockResolvedValue({
      accepted: true,
      path: "projects/",
      ownerHandle: "@owner:matrix-os.com",
    });

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share/accept", {
      shareId: "550e8400-e29b-41d4-a716-446655440000",
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.accepted).toBe(true);
    expect(json.path).toBe("projects/");
    expect(json.ownerHandle).toBe("@owner:matrix-os.com");
  });

  it("POST /share/accept returns 404 when share not found", async () => {
    mockSharing.acceptShare.mockRejectedValue(new ShareNotFoundError("nonexistent"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share/accept", {
      shareId: "550e8400-e29b-41d4-a716-446655440000",
    }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Share not found" });
  });

  it("POST /share/accept returns 403 when caller is not grantee", async () => {
    mockSharing.acceptShare.mockRejectedValue(new ShareForbiddenError("Not the grantee"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share/accept", {
      shareId: "550e8400-e29b-41d4-a716-446655440000",
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("GET /shares returns owned and received", async () => {
    mockSharing.listShares.mockResolvedValue({ owned: [], received: [] });

    const app = createTestApp();
    const res = await app.request("/api/sync/shares");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.owned).toEqual([]);
    expect(json.received).toEqual([]);
  });
});
