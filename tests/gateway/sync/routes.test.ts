import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  ShareNotFoundError,
  ShareSelfError,
  ShareDuplicateError,
  ShareForbiddenError,
  GranteeNotFoundError,
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
  destroy: vi.fn(),
};

const mockDb = {
  getManifestMeta: vi.fn(),
  getAggregateManifestStats: vi.fn(),
  upsertManifestMeta: vi.fn(),
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
  checkSharePermission: vi.fn(),
};

import { createSyncRoutes, type SyncRouteDeps } from "../../../packages/gateway/src/sync/routes.js";

function createTestApp(overrides?: Partial<SyncRouteDeps>) {
  const deps: SyncRouteDeps = {
    r2: mockR2,
    db: mockDb as any,
    peerRegistry: mockPeerRegistry,
    sharing: mockSharing,
    getUserId: () => "test-user",
    getPeerId: () => "test-peer",
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
    init.body = JSON.stringify(body);
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

  it("returns 429 when rate limit exceeded", async () => {
    // Each createTestApp creates its own rate limiter instance (100 req/min)
    const app = createTestApp();

    // Send 100 requests (at limit)
    for (let i = 0; i < 100; i++) {
      const res = await app.request(jsonRequest("/api/sync/presign", {
        files: [{ path: `file-${i}.txt`, action: "get" }],
      }));
      expect(res.status).toBe(200);
    }

    // 101st should be rate limited
    const res = await app.request(jsonRequest("/api/sync/presign", {
      files: [{ path: "one-too-many.txt", action: "get" }],
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

    const app = createTestApp();
    const res = await app.request("/api/sync/status");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connectedPeers).toHaveLength(1);
    expect(json.connectedPeers[0].peerId).toBe("p1");
    expect(json.manifestVersion).toBe(5);
    expect(json.fileCount).toBe(100);
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
  beforeEach(() => vi.clearAllMocks());

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

  it("deletes conflict copy from R2 when conflictPath is provided", async () => {
    mockR2.deleteObject.mockResolvedValue(undefined);

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/resolve-conflict", {
      path: "readme.md",
      resolution: "keep-local",
      conflictPath: "readme (conflict - peer1 - 2026-04-14).md",
    }));

    expect(res.status).toBe(200);
    expect(mockR2.deleteObject).toHaveBeenCalledWith(
      "matrixos-sync/test-user/files/readme (conflict - peer1 - 2026-04-14).md",
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

  it("POST /share returns 404 when grantee not found", async () => {
    mockSharing.createShare.mockRejectedValue(new GranteeNotFoundError("@nobody:matrix-os.com"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/",
      granteeHandle: "@nobody:matrix-os.com",
      role: "viewer",
    }));

    expect(res.status).toBe(404);
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
  });

  it("POST /share returns 409 on duplicate", async () => {
    mockSharing.createShare.mockRejectedValue(new ShareDuplicateError());

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share", {
      path: "projects/startup/",
      granteeHandle: "@colleague:matrix-os.com",
      role: "editor",
    }));

    expect(res.status).toBe(409);
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
  });

  it("POST /share/accept returns 403 when caller is not grantee", async () => {
    mockSharing.acceptShare.mockRejectedValue(new ShareForbiddenError("Not the grantee"));

    const app = createTestApp();
    const res = await app.request(jsonRequest("/api/sync/share/accept", {
      shareId: "550e8400-e29b-41d4-a716-446655440000",
    }));

    expect(res.status).toBe(403);
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
