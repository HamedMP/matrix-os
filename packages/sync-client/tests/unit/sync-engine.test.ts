import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  detectChanges,
  buildPresignBatch,
  type ChangeSet,
  type PresignRequest,
} from "../../src/daemon/sync-engine.js";
import type { SyncState } from "../../src/daemon/manifest-cache.js";
import type { Manifest } from "../../src/daemon/types.js";
import type { SyncIgnorePatterns } from "../../src/lib/syncignore.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-sync-engine-test");

const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("detectChanges", () => {
  const emptyIgnore: SyncIgnorePatterns = { patterns: [], negations: [] };

  it("detects local-newer files for upload", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "src/app.ts": { hash: HASH_B, mtime: 2000, size: 200, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "src/app.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.uploads).toContainEqual(
      expect.objectContaining({ path: "src/app.ts", hash: HASH_B }),
    );
  });

  it("detects remote-newer files for download", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "src/app.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "src/app.ts": { hash: HASH_B, size: 200, mtime: 2000, peerId: "peer-2", version: 2 },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.downloads).toContainEqual(
      expect.objectContaining({ path: "src/app.ts", hash: HASH_B }),
    );
  });

  it("detects conflicts when both sides changed", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "src/app.ts": { hash: HASH_B, mtime: 2000, size: 150, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "src/app.ts": { hash: HASH_C, size: 200, mtime: 2000, peerId: "peer-2", version: 2 },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.conflicts).toContainEqual(
      expect.objectContaining({
        path: "src/app.ts",
        localHash: HASH_B,
        remoteHash: HASH_C,
      }),
    );
  });

  it("skips files that match ignore patterns", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "node_modules/ws/index.js": { hash: HASH_B, mtime: 2000, size: 100 },
        "src/app.ts": { hash: HASH_B, mtime: 2000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "src/app.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };
    const ignorePatterns: SyncIgnorePatterns = {
      patterns: ["node_modules/"],
      negations: [],
    };

    const changes = detectChanges(localState, remoteManifest, ignorePatterns);

    const allPaths = [
      ...changes.uploads.map((u) => u.path),
      ...changes.downloads.map((d) => d.path),
      ...changes.conflicts.map((c) => c.path),
    ];
    expect(allPaths).not.toContain("node_modules/ws/index.js");
  });

  it("detects new remote files not present locally", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {},
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "new-file.ts": { hash: HASH_A, size: 100, mtime: 2000, peerId: "peer-2", version: 1 },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.downloads).toContainEqual(
      expect.objectContaining({ path: "new-file.ts" }),
    );
  });

  it("returns empty change set when everything is in sync", () => {
    const localState: SyncState = {
      manifestVersion: 2,
      lastSyncAt: 2000,
      files: {
        "app.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "app.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.uploads).toHaveLength(0);
    expect(changes.downloads).toHaveLength(0);
    expect(changes.conflicts).toHaveLength(0);
  });

  it("handles remote tombstones (deleted files)", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "old.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "old.ts": {
          hash: HASH_A,
          size: 0,
          mtime: 2000,
          peerId: "peer-2",
          version: 2,
          deleted: true,
          deletedAt: 2000,
        },
      },
    };

    const changes = detectChanges(localState, remoteManifest, emptyIgnore);

    expect(changes.deletions).toContainEqual(
      expect.objectContaining({ path: "old.ts" }),
    );
  });
});

describe("buildPresignBatch", () => {
  it("creates presign requests for uploads", () => {
    const changes: ChangeSet = {
      uploads: [
        { path: "file1.ts", hash: HASH_A, size: 100 },
        { path: "file2.ts", hash: HASH_B, size: 200 },
      ],
      downloads: [],
      conflicts: [],
      deletions: [],
    };

    const requests = buildPresignBatch(changes);

    expect(requests).toContainEqual(
      expect.objectContaining({ path: "file1.ts", action: "put" }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({ path: "file2.ts", action: "put" }),
    );
  });

  it("creates presign requests for downloads", () => {
    const changes: ChangeSet = {
      uploads: [],
      downloads: [
        { path: "remote.ts", hash: HASH_A, size: 100 },
      ],
      conflicts: [],
      deletions: [],
    };

    const requests = buildPresignBatch(changes);

    expect(requests).toContainEqual(
      expect.objectContaining({ path: "remote.ts", action: "get" }),
    );
  });

  it("limits batch size to 100 presign requests", () => {
    const uploads = Array.from({ length: 150 }, (_, i) => ({
      path: `file-${i}.ts`,
      hash: HASH_A,
      size: 100,
    }));
    const changes: ChangeSet = {
      uploads,
      downloads: [],
      conflicts: [],
      deletions: [],
    };

    const requests = buildPresignBatch(changes);

    expect(requests).toHaveLength(100);
  });

  it("returns empty array for no changes", () => {
    const changes: ChangeSet = {
      uploads: [],
      downloads: [],
      conflicts: [],
      deletions: [],
    };

    const requests = buildPresignBatch(changes);

    expect(requests).toHaveLength(0);
  });

  it("includes both uploads and downloads in a single batch", () => {
    const changes: ChangeSet = {
      uploads: [{ path: "up.ts", hash: HASH_A, size: 100 }],
      downloads: [{ path: "down.ts", hash: HASH_B, size: 200 }],
      conflicts: [],
      deletions: [],
    };

    const requests = buildPresignBatch(changes);

    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.action).sort()).toEqual(["get", "put"]);
  });
});
