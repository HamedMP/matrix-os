import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { insertContainer, insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createInternalSyncRoutes } from "../../packages/platform/src/internal-sync-routes.js";
import { createApp } from "../../packages/platform/src/main.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";

function bearerFor(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(handle).digest("hex");
}

describe("platform/internal-sync-routes", () => {
  let db: PlatformDB;

  const r2 = {
    getPresignedGetUrl: vi.fn(),
    getPresignedPutUrl: vi.fn(),
    createMultipartUpload: vi.fn(),
    getPresignedPartUrl: vi.fn(),
    getObject: vi.fn(),
    putObject: vi.fn(),
    deleteObject: vi.fn(),
    completeMultipartUpload: vi.fn(),
    abortMultipartUpload: vi.fn(),
    destroy: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
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

  it("authorizes VPS-native user machines when no legacy container row exists", async () => {
    await insertUserMachine(db, {
      machineId: "machine-bob",
      clerkUserId: "user_bob",
      handle: "bob",
      hetznerServerId: 456,
      publicIPv4: "203.0.113.12",
      status: "running",
      imageVersion: "matrix-os-host-dev",
      provisionedAt: "2026-05-06T00:00:00.000Z",
    });
    r2.getPresignedGetUrl.mockResolvedValue("https://platform.example/presigned-get");
    const app = createTestApp();

    const res = await app.request("/internal/containers/bob/sync/presign/get", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("bob", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_bob/manifest.json",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://platform.example/presigned-get" });
    expect(r2.getPresignedGetUrl).toHaveBeenCalledWith(
      "matrixos-sync/user_bob/manifest.json",
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

  it("completes multipart uploads only for keys in the container user's prefix", async () => {
    r2.completeMultipartUpload.mockResolvedValue({ etag: '"complete-etag"' });
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/multipart/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/videos/large.mov",
        uploadId: "upload-123",
        parts: [
          { partNumber: 1, etag: '"etag-1"' },
          { partNumber: 2, etag: '"etag-2"' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: '"complete-etag"' });
    expect(r2.completeMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/user_alice/files/videos/large.mov",
      "upload-123",
      [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
      ],
    );
  });

  it("rejects multipart complete requests with oversized ETags", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/multipart/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/videos/large.mov",
        uploadId: "upload-123",
        parts: [{ partNumber: 1, etag: "x".repeat(513) }],
      }),
    });

    expect(res.status).toBe(400);
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("accepts multipart complete bodies over 64KB within the internal complete cap", async () => {
    r2.completeMultipartUpload.mockResolvedValue({ etag: '"complete-etag"' });
    const app = createTestApp();
    const parts = Array.from({ length: 140 }, (_, index) => ({
      partNumber: index + 1,
      etag: `"${String(index + 1).padStart(5, "0")}-${"e".repeat(490)}"`,
    }));
    const body = JSON.stringify({
      key: "matrixos-sync/user_alice/files/videos/large.mov",
      uploadId: "upload-123",
      parts,
    });

    expect(Buffer.byteLength(body)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);

    const res = await app.request("/internal/containers/alice/sync/multipart/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: '"complete-etag"' });
    expect(r2.completeMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/user_alice/files/videos/large.mov",
      "upload-123",
      parts,
    );
  });

  it("returns a generic JSON 500 when multipart completion fails in storage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    r2.completeMultipartUpload.mockRejectedValue(new Error("r2 complete exploded"));
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/multipart/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/videos/large.mov",
        uploadId: "upload-123",
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Multipart completion failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[internal-sync] Multipart completion failed:",
      expect.any(String),
    );
  });

  it("aborts multipart uploads only for keys in the container user's prefix", async () => {
    r2.abortMultipartUpload.mockResolvedValue(undefined);
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/multipart/abort", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/videos/large.mov",
        uploadId: "upload-123",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(r2.abortMultipartUpload).toHaveBeenCalledWith(
      "matrixos-sync/user_alice/files/videos/large.mov",
      "upload-123",
    );
  });

  it("returns a generic JSON 500 when multipart abort fails in storage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    r2.abortMultipartUpload.mockRejectedValue(new Error("r2 abort exploded"));
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/multipart/abort", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        key: "matrixos-sync/user_alice/files/videos/large.mov",
        uploadId: "upload-123",
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Multipart abort failed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "[internal-sync] Multipart abort failed:",
      expect.any(String),
    );
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

  it("rejects oversized direct object uploads with 413", async () => {
    const app = createTestApp();
    const body = "x";

    const res = await app.request(
      "/internal/containers/alice/sync/object?key=matrixos-sync%2Fuser_alice%2Fmanifest.json",
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
          "content-length": String(101 * 1024 * 1024),
          "content-type": "application/octet-stream",
        },
        body,
      },
    );

    expect(res.status).toBe(413);
    expect(r2.putObject).not.toHaveBeenCalled();
  });

  it("streams direct object uploads through to storage", async () => {
    r2.putObject.mockResolvedValue({ etag: '"etag-1"' });
    const app = createTestApp();

    const res = await app.request(
      "/internal/containers/alice/sync/object?key=matrixos-sync%2Fuser_alice%2Fmanifest.json",
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
          "content-type": "application/octet-stream",
        },
        body: "hello world",
      },
    );

    expect(res.status).toBe(200);
    expect(r2.putObject).toHaveBeenCalledWith(
      "matrixos-sync/user_alice/manifest.json",
      expect.objectContaining({ getReader: expect.any(Function) }),
    );
  });

  it("logs malformed JSON parse failures before returning 400", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/sync/presign/get", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(res.status).toBe(400);
    expect(warnSpy).toHaveBeenCalledWith(
      "[internal-sync] JSON parse failed:",
      expect.any(String),
    );
  });

  it("rejects oversized DELETE bodies with 413", async () => {
    const app = createTestApp();

    const res = await app.request(
      "/internal/containers/alice/sync/object?key=matrixos-sync%2Fuser_alice%2Fmanifest.json",
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
          "content-type": "application/octet-stream",
          "content-length": String(65 * 1024),
        },
        body: "x",
      },
    );

    expect(res.status).toBe(413);
    expect(r2.deleteObject).not.toHaveBeenCalled();
  });
});
