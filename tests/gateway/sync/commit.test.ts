import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "../../../packages/gateway/src/sync/types.js";

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);

function makeManifest(files: Record<string, { hash: string; size: number }>): Manifest {
  const entries: Manifest["files"] = {};
  for (const [path, { hash, size }] of Object.entries(files)) {
    entries[path] = {
      hash,
      size,
      mtime: Date.now(),
      peerId: "test-peer",
      version: 1,
    };
  }
  return { version: 2, files: entries };
}

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

const mockBroadcast = vi.fn();

import {
  handleCommit,
  type CommitDeps,
} from "../../../packages/gateway/src/sync/commit.js";

describe("handleCommit", () => {
  let deps: CommitDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.withAdvisoryLock.mockImplementation(async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(undefined));
    mockDb.getManifestMeta.mockResolvedValue(null);
    mockR2.getObject.mockRejectedValue(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
    deps = {
      r2: mockR2,
      db: mockDb as any,
      broadcast: mockBroadcast,
    };
  });

  it("commits new files and returns updated version", async () => {
    const manifest = makeManifest({});
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e1"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e1"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "new.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 0,
    });

    expect(result.manifestVersion).toBe(1);
    expect(result.committed).toBe(1);
  });

  it("returns version_conflict when expectedVersion does not match", async () => {
    mockDb.getManifestMeta.mockResolvedValue({ version: 5, etag: '"e"' });

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "test.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 3,
    });

    expect(result).toEqual({
      error: "version_conflict",
      currentVersion: 5,
      expectedVersion: 3,
    });
  });

  it("returns a generic invalid file path error", async () => {
    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "../escape.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 0,
    });

    expect(result).toEqual({
      error: "Invalid file path",
      currentVersion: 0,
      expectedVersion: 0,
    });
  });

  it("uses the embedded manifestVersion when R2 is ahead of DB metadata", async () => {
    const manifest = makeManifest({});
    const body = { text: () => Promise.resolve(JSON.stringify({ ...manifest, manifestVersion: 7 })) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e7"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 5, etag: '"e5"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "test.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 5,
    });

    expect(result).toEqual({
      error: "version_conflict",
      currentVersion: 7,
      expectedVersion: 5,
    });
  });

  it("broadcasts sync:change to peers after successful commit", async () => {
    const manifest = makeManifest({});
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "changed.txt", hash: HASH_A, size: 50 }],
      expectedVersion: 0,
    });

    expect(mockBroadcast).toHaveBeenCalledWith("user1", "peer1", {
      type: "sync:change",
      files: [expect.objectContaining({ path: "changed.txt", hash: HASH_A })],
      peerId: "peer1",
      manifestVersion: 1,
    });
  });

  it("handles delete action with tombstone", async () => {
    const manifest = makeManifest({ "deleted.txt": { hash: HASH_A, size: 100 } });
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 2, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "deleted.txt", hash: HASH_A, size: 0, action: "delete" }],
      expectedVersion: 2,
    });

    expect(result.committed).toBe(1);
    // Verify the R2 delete was called for the file content
    expect(mockR2.deleteObject).toHaveBeenCalledWith(
      "matrixos-sync/user1/files/deleted.txt",
    );
  });

  it("writes the new manifest before deleting file blobs", async () => {
    const manifest = makeManifest({ "deleted.txt": { hash: HASH_A, size: 100 } });
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 2, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "deleted.txt", hash: HASH_A, size: 0, action: "delete" }],
      expectedVersion: 2,
    });

    expect(mockR2.putObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockR2.deleteObject.mock.invocationCallOrder[0],
    );
  });

  it("logs and continues when blob deletion fails after the manifest update", async () => {
    const manifest = makeManifest({ "deleted.txt": { hash: HASH_A, size: 100 } });
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 2, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockR2.deleteObject.mockRejectedValueOnce(new Error("r2 delete failed"));
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "deleted.txt", hash: HASH_A, size: 0, action: "delete" }],
      expectedVersion: 2,
    });

    expect(result).toEqual({ manifestVersion: 3, committed: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      "[sync/commit] Failed to delete stale file blob after manifest update:",
      "r2 delete failed",
    );
  });

  it("garbage-collects expired tombstones before writing the manifest", async () => {
    const oldDeletedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const manifest: Manifest = {
      version: 2,
      files: {
        "old.txt": {
          hash: HASH_A,
          size: 0,
          mtime: oldDeletedAt,
          peerId: "peer1",
          version: 1,
          deleted: true,
          deletedAt: oldDeletedAt,
        },
      },
    };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 2, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "new.txt", hash: HASH_B, size: 1 }],
      expectedVersion: 2,
    });

    const [, manifestBody] = mockR2.putObject.mock.calls[0]!;
    const written = JSON.parse(String(manifestBody));
    expect(written.files["old.txt"]).toBeUndefined();
    expect(written.files["new.txt"]).toBeDefined();
  });

  it("rejects commit when file count would exceed 50K", async () => {
    // Create manifest near the 50K limit
    const files: Record<string, any> = {};
    for (let i = 0; i < 50_000; i++) {
      files[`file-${i}.txt`] = {
        hash: HASH_A,
        size: 1,
        mtime: Date.now(),
        peerId: "peer",
        version: 1,
      };
    }
    const manifest: Manifest = { version: 2, files };
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 10, etag: '"e"' });

    const result = await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "overflow.txt", hash: HASH_B, size: 1 }],
      expectedVersion: 10,
    });

    expect(result).toHaveProperty("error");
    expect((result as any).error).toMatch(/cap|limit|50/i);
  });

  it("acquires advisory lock for the commit", async () => {
    const manifest = makeManifest({});
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"e"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "test.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 0,
    });

    expect(mockDb.withAdvisoryLock).toHaveBeenCalledWith("user1", expect.any(Function));
  });

  it("uses the advisory-lock transaction executor for manifest metadata reads and writes", async () => {
    const manifest = makeManifest({});
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    const txn = { kind: "trx" };
    mockDb.withAdvisoryLock.mockImplementationOnce(
      async (_userId: string, fn: (executor: unknown) => Promise<unknown>) => fn(txn),
    );
    mockR2.getObject.mockResolvedValue({ body, etag: '"e1"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 0, etag: '"e1"' });
    mockR2.putObject.mockResolvedValue({ etag: '"e2"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await handleCommit(deps, "user1", "peer1", {
      files: [{ path: "new.txt", hash: HASH_A, size: 100 }],
      expectedVersion: 0,
    });

    expect(mockDb.getManifestMeta).toHaveBeenCalledWith("user1", txn);
    expect(mockDb.upsertManifestMeta).toHaveBeenCalledWith(
      "user1",
      expect.objectContaining({ version: 1 }),
      txn,
    );
  });
});
