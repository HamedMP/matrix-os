import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createPlatformDb, insertContainer, type PlatformDB } from "../../packages/platform/src/db.js";
import { createInternalSyncRoutes } from "../../packages/platform/src/internal-sync-routes.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

function bearerFor(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(handle).digest("hex");
}

describe("platform/internal-sync-routes", () => {
  let tmpDir: string;
  let db: PlatformDB;

  const r2 = {
    getPresignedGetUrl: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    createMultipartUpload: vi.fn(),
    getPresignedPartUrl: vi.fn(),
    getObject: vi.fn(),
    putObject: vi.fn(),
    deleteObject: vi.fn(),
    destroy: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "platform-internal-sync-"));
    db = createPlatformDb(join(tmpDir, "test.db"));
    insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function stubOrchestrator(): Orchestrator {
    return {
      provision: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      upgrade: vi.fn(),
      rollingRestart: vi.fn(),
      getInfo: vi.fn(),
      getImage: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      syncStates: vi.fn(),
    };
  }

  function createTestApp() {
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
      internalSyncRoutes: createInternalSyncRoutes({
        db,
        r2,
        platformSecret: "platform-secret-123",
      }),
    });
  }

  it("rejects requests without the per-container bearer token", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/presign/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "matrixos-sync/user_alice/manifest.json" }),
    });

    expect(res.status).toBe(401);
    expect(r2.getPresignedGetUrl).not.toHaveBeenCalled();
  });

  it("presigns only keys that belong to the container user", async () => {
    r2.getPresignedPutUrl.mockResolvedValue("https://platform.example/presigned-put");
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/presign/put", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/apps/test.txt",
        size: 123,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://platform.example/presigned-put" });
    expect(r2.getPresignedPutUrl).toHaveBeenCalledWith(
      "matrixos-sync/user_alice/files/apps/test.txt",
      123,
      undefined,
    );
  });

  it("rejects keys outside the container user's prefix", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/presign/get", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ key: "matrixos-sync/user_bob/files/secret.txt" }),
    });

    expect(res.status).toBe(403);
    expect(r2.getPresignedGetUrl).not.toHaveBeenCalled();
  });

  it("maps NoSuchKey from storage reads to a 404", async () => {
    const err = new Error("NoSuchKey");
    err.name = "NoSuchKey";
    r2.getObject.mockRejectedValue(err);
    const app = createTestApp();

    const res = await app.request(
      "/internal/containers/alice/sync/object?key=matrixos-sync%2Fuser_alice%2Fmanifest.json",
      {
        headers: {
          authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        },
      },
    );

    expect(res.status).toBe(404);
  });
});
