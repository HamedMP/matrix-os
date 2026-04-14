import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "../../../packages/gateway/src/sync/types.js";

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);
const HASH_C = "sha256:" + "c".repeat(64);

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

// Mock R2 client
const mockR2 = {
  getObject: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  getPresignedGetUrl: vi.fn(),
  getPresignedPutUrl: vi.fn(),
  destroy: vi.fn(),
};

// Mock DB for manifest metadata
const mockDb = {
  getManifestMeta: vi.fn(),
  upsertManifestMeta: vi.fn(),
  withAdvisoryLock: vi.fn(),
};

import {
  readManifest,
  writeManifest,
  applyCommitToManifest,
  garbageCollectTombstones,
  type ManifestStore,
} from "../../../packages/gateway/src/sync/manifest.js";

describe("readManifest", () => {
  let store: ManifestStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = { r2: mockR2, db: mockDb as any };
  });

  it("returns empty manifest when R2 has no manifest", async () => {
    mockR2.getObject.mockRejectedValue(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));
    mockDb.getManifestMeta.mockResolvedValue(null);

    const result = await readManifest(store, "user1");

    expect(result.manifest.version).toBe(2);
    expect(Object.keys(result.manifest.files)).toHaveLength(0);
    expect(result.manifestVersion).toBe(0);
  });

  it("reads and parses manifest from R2", async () => {
    const manifest = makeManifest({ "test.txt": { hash: HASH_A, size: 100 } });
    const body = { text: () => Promise.resolve(JSON.stringify(manifest)) };
    mockR2.getObject.mockResolvedValue({ body, etag: '"etag1"' });
    mockDb.getManifestMeta.mockResolvedValue({ version: 3, etag: '"etag1"' });

    const result = await readManifest(store, "user1");

    expect(result.manifest.files["test.txt"]!.hash).toBe(HASH_A);
    expect(result.manifestVersion).toBe(3);
    expect(result.etag).toBe('"etag1"');
  });
});

describe("writeManifest", () => {
  let store: ManifestStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = { r2: mockR2, db: mockDb as any };
  });

  it("writes manifest to R2 and updates Postgres metadata", async () => {
    const manifest = makeManifest({ "file.txt": { hash: HASH_A, size: 200 } });
    mockR2.putObject.mockResolvedValue({ etag: '"new-etag"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await writeManifest(store, "user1", manifest, 5);

    expect(mockR2.putObject).toHaveBeenCalledOnce();
    expect(mockDb.upsertManifestMeta).toHaveBeenCalledWith(
      "user1",
      expect.objectContaining({
        version: 5,
        file_count: 1,
        etag: '"new-etag"',
      }),
    );
  });

  it("computes correct file_count excluding tombstones", async () => {
    const manifest = makeManifest({
      "live.txt": { hash: HASH_A, size: 100 },
      "dead.txt": { hash: HASH_B, size: 50 },
    });
    manifest.files["dead.txt"]!.deleted = true;
    manifest.files["dead.txt"]!.deletedAt = Date.now();

    mockR2.putObject.mockResolvedValue({ etag: '"e"' });
    mockDb.upsertManifestMeta.mockResolvedValue(undefined);

    await writeManifest(store, "user1", manifest, 1);

    expect(mockDb.upsertManifestMeta).toHaveBeenCalledWith(
      "user1",
      expect.objectContaining({ file_count: 1 }),
    );
  });
});

describe("applyCommitToManifest", () => {
  it("adds new files to manifest", () => {
    const manifest = makeManifest({});
    const files = [{ path: "new.txt", hash: HASH_A, size: 100 }];

    const result = applyCommitToManifest(manifest, files, "peer1");

    expect(result.files["new.txt"]).toBeDefined();
    expect(result.files["new.txt"]!.hash).toBe(HASH_A);
    expect(result.files["new.txt"]!.peerId).toBe("peer1");
    expect(result.files["new.txt"]!.version).toBe(1);
  });

  it("updates existing files with incremented version", () => {
    const manifest = makeManifest({ "existing.txt": { hash: HASH_A, size: 100 } });
    manifest.files["existing.txt"]!.version = 5;
    const files = [{ path: "existing.txt", hash: HASH_B, size: 200 }];

    const result = applyCommitToManifest(manifest, files, "peer2");

    expect(result.files["existing.txt"]!.hash).toBe(HASH_B);
    expect(result.files["existing.txt"]!.size).toBe(200);
    expect(result.files["existing.txt"]!.version).toBe(6);
    expect(result.files["existing.txt"]!.peerId).toBe("peer2");
  });

  it("marks files as tombstones on delete action", () => {
    const manifest = makeManifest({ "deleted.txt": { hash: HASH_A, size: 100 } });
    const files = [{ path: "deleted.txt", hash: HASH_A, size: 0, action: "delete" as const }];

    const result = applyCommitToManifest(manifest, files, "peer1");

    expect(result.files["deleted.txt"]!.deleted).toBe(true);
    expect(result.files["deleted.txt"]!.deletedAt).toBeDefined();
    expect(result.files["deleted.txt"]!.size).toBe(0);
  });

  it("un-tombstones when a deleted file is re-added (delete-edit conflict: edit wins)", () => {
    const manifest = makeManifest({ "revived.txt": { hash: HASH_A, size: 100 } });
    manifest.files["revived.txt"]!.deleted = true;
    manifest.files["revived.txt"]!.deletedAt = Date.now();
    const files = [{ path: "revived.txt", hash: HASH_C, size: 300, action: "add" as const }];

    const result = applyCommitToManifest(manifest, files, "peer1");

    expect(result.files["revived.txt"]!.deleted).toBeUndefined();
    expect(result.files["revived.txt"]!.deletedAt).toBeUndefined();
    expect(result.files["revived.txt"]!.hash).toBe(HASH_C);
  });

  it("rejects commits that would exceed 50K file cap", () => {
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
    const newFiles = [{ path: "one-too-many.txt", hash: HASH_B, size: 1 }];

    expect(() => applyCommitToManifest(manifest, newFiles, "peer")).toThrow(/50,?000/);
  });

  it("tracks total_size correctly across additions", () => {
    const manifest = makeManifest({ "a.txt": { hash: HASH_A, size: 100 } });
    const files = [{ path: "b.txt", hash: HASH_B, size: 200 }];

    const result = applyCommitToManifest(manifest, files, "peer");

    const totalSize = Object.values(result.files)
      .filter((e) => !e.deleted)
      .reduce((sum, e) => sum + e.size, 0);
    expect(totalSize).toBe(300);
  });
});

describe("garbageCollectTombstones", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("removes tombstones older than maxAgeDays", () => {
    const manifest = makeManifest({ "live.txt": { hash: HASH_A, size: 100 } });
    manifest.files["old-dead.txt"] = {
      hash: HASH_B,
      size: 0,
      mtime: Date.now(),
      peerId: "peer",
      version: 2,
      deleted: true,
      deletedAt: Date.now() - 31 * DAY_MS,
    };

    const result = garbageCollectTombstones(manifest);

    expect(result.files["live.txt"]).toBeDefined();
    expect(result.files["old-dead.txt"]).toBeUndefined();
  });

  it("keeps tombstones younger than maxAgeDays", () => {
    const manifest = makeManifest({});
    manifest.files["recent-dead.txt"] = {
      hash: HASH_A,
      size: 0,
      mtime: Date.now(),
      peerId: "peer",
      version: 1,
      deleted: true,
      deletedAt: Date.now() - 5 * DAY_MS,
    };

    const result = garbageCollectTombstones(manifest);

    expect(result.files["recent-dead.txt"]).toBeDefined();
    expect(result.files["recent-dead.txt"]!.deleted).toBe(true);
  });

  it("does not touch live files", () => {
    const manifest = makeManifest({
      "file1.txt": { hash: HASH_A, size: 100 },
      "file2.txt": { hash: HASH_B, size: 200 },
    });

    const result = garbageCollectTombstones(manifest);

    expect(Object.keys(result.files)).toHaveLength(2);
  });

  it("respects custom maxAgeDays", () => {
    const manifest = makeManifest({});
    manifest.files["dead.txt"] = {
      hash: HASH_A,
      size: 0,
      mtime: Date.now(),
      peerId: "peer",
      version: 1,
      deleted: true,
      deletedAt: Date.now() - 8 * DAY_MS,
    };

    // 7 days -- should be collected
    const result7 = garbageCollectTombstones(manifest, 7);
    expect(result7.files["dead.txt"]).toBeUndefined();

    // 10 days -- should be kept
    const result10 = garbageCollectTombstones(manifest, 10);
    expect(result10.files["dead.txt"]).toBeDefined();
  });

  it("handles tombstones with missing deletedAt (treats as ancient)", () => {
    const manifest = makeManifest({});
    manifest.files["no-timestamp.txt"] = {
      hash: HASH_A,
      size: 0,
      mtime: Date.now(),
      peerId: "peer",
      version: 1,
      deleted: true,
    };

    const result = garbageCollectTombstones(manifest);

    expect(result.files["no-timestamp.txt"]).toBeUndefined();
  });

  it("returns count of collected tombstones", () => {
    const manifest = makeManifest({ "live.txt": { hash: HASH_A, size: 100 } });
    manifest.files["dead1.txt"] = {
      hash: HASH_A, size: 0, mtime: Date.now(), peerId: "p", version: 1,
      deleted: true, deletedAt: Date.now() - 31 * DAY_MS,
    };
    manifest.files["dead2.txt"] = {
      hash: HASH_B, size: 0, mtime: Date.now(), peerId: "p", version: 1,
      deleted: true, deletedAt: Date.now() - 45 * DAY_MS,
    };

    const result = garbageCollectTombstones(manifest);

    expect(result.collected).toBe(2);
    expect(Object.keys(result.files)).toHaveLength(1);
  });
});
