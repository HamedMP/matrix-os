import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadSyncState,
  saveSyncState,
  compareSyncState,
  type SyncState,
  type SyncAction,
} from "../../src/daemon/manifest-cache.js";
import type { Manifest } from "../../src/daemon/types.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-manifest-cache-test");
const STATE_PATH = join(TEST_DIR, "sync-state.json");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("loadSyncState", () => {
  it("returns empty default state when file does not exist", async () => {
    const state = await loadSyncState(join(TEST_DIR, "nonexistent.json"));

    expect(state.manifestVersion).toBe(0);
    expect(state.lastSyncAt).toBe(0);
    expect(Object.keys(state.files)).toHaveLength(0);
  });

  it("loads and parses a valid sync state file", async () => {
    const data: SyncState = {
      manifestVersion: 5,
      lastSyncAt: 1700000000000,
      files: {
        "src/index.ts": {
          hash: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          mtime: 1700000000000,
          size: 1024,
          lastSyncedHash: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        },
      },
    };
    await writeFile(STATE_PATH, JSON.stringify(data));

    const state = await loadSyncState(STATE_PATH);

    expect(state.manifestVersion).toBe(5);
    expect(state.files["src/index.ts"]?.hash).toBe(data.files["src/index.ts"]!.hash);
  });

  it("throws on malformed JSON", async () => {
    await writeFile(STATE_PATH, "not valid json {{{");

    await expect(loadSyncState(STATE_PATH)).rejects.toThrow();
  });

  it("throws on invalid schema (missing required fields)", async () => {
    await writeFile(STATE_PATH, JSON.stringify({ manifestVersion: "not-a-number" }));

    await expect(loadSyncState(STATE_PATH)).rejects.toThrow();
  });
});

describe("saveSyncState", () => {
  it("writes sync state as JSON to the given path", async () => {
    const state: SyncState = {
      manifestVersion: 3,
      lastSyncAt: 1700000000000,
      files: {
        "README.md": {
          hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          mtime: 1700000000000,
          size: 256,
        },
      },
    };

    await saveSyncState(STATE_PATH, state);

    const raw = await readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.manifestVersion).toBe(3);
    expect(parsed.files["README.md"].hash).toBe(state.files["README.md"]!.hash);
  });

  it("overwrites an existing state file", async () => {
    const state1: SyncState = { manifestVersion: 1, lastSyncAt: 0, files: {} };
    const state2: SyncState = { manifestVersion: 2, lastSyncAt: 1000, files: {} };

    await saveSyncState(STATE_PATH, state1);
    await saveSyncState(STATE_PATH, state2);

    const raw = await readFile(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.manifestVersion).toBe(2);
  });

  it("creates parent directories if they do not exist", async () => {
    const deepPath = join(TEST_DIR, "deep", "nested", "sync-state.json");
    const state: SyncState = { manifestVersion: 0, lastSyncAt: 0, files: {} };

    await saveSyncState(deepPath, state);

    const raw = await readFile(deepPath, "utf-8");
    expect(JSON.parse(raw).manifestVersion).toBe(0);
  });

  it("does not leave temporary files behind after saving", async () => {
    const state: SyncState = { manifestVersion: 4, lastSyncAt: 0, files: {} };

    await saveSyncState(STATE_PATH, state);

    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(TEST_DIR));
    expect(entries.filter((entry) => entry.includes(".tmp"))).toEqual([]);
  });
});

describe("compareSyncState", () => {
  const HASH_A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const HASH_B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const HASH_C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  it("detects local-newer when local hash changed but remote matches lastSyncedHash", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "file.ts": { hash: HASH_B, mtime: 2000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "file.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "file.ts", action: "upload" }),
    );
  });

  it("detects remote-newer when remote hash changed but local matches lastSyncedHash", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "file.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "file.ts": { hash: HASH_B, size: 200, mtime: 2000, peerId: "peer-2", version: 2 },
      },
    };

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "file.ts", action: "download" }),
    );
  });

  it("detects conflict when both local and remote changed differently", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "file.ts": { hash: HASH_B, mtime: 2000, size: 150, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "file.ts": { hash: HASH_C, size: 200, mtime: 2000, peerId: "peer-2", version: 2 },
      },
    };

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "file.ts", action: "conflict" }),
    );
  });

  it("returns no action when hashes match (already in sync)", () => {
    const localState: SyncState = {
      manifestVersion: 2,
      lastSyncAt: 2000,
      files: {
        "file.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "file.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };

    const actions = compareSyncState(localState, remoteManifest);

    const fileActions = actions.filter((a) => a.path === "file.ts");
    expect(fileActions).toHaveLength(0);
  });

  it("detects new remote file (not in local state)", () => {
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

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "new-file.ts", action: "download" }),
    );
  });

  it("detects local file deleted (in local state with lastSyncedHash but missing from local now)", () => {
    // A file that was synced but has been locally deleted would be tracked
    // by the watcher, but at compare time the file entry might be flagged
    // We use a separate "deleted" marker convention
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "deleted.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        // File still exists remotely but is gone locally
        "deleted.ts": { hash: HASH_A, size: 100, mtime: 1000, peerId: "peer-1", version: 1 },
      },
    };

    // When watcher detects a delete, the sync engine handles it.
    // compareSyncState with a localDeleted flag should produce delete action.
    const actions = compareSyncState(localState, remoteManifest, {
      localDeleted: ["deleted.ts"],
    });

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "deleted.ts", action: "delete" }),
    );
  });

  it("detects remote tombstone (deleted remotely, should delete locally)", () => {
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "removed.ts": { hash: HASH_A, mtime: 1000, size: 100, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "removed.ts": {
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

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toContainEqual(
      expect.objectContaining({ path: "removed.ts", action: "delete-local" }),
    );
  });

  it("handles delete-edit conflict (edit wins over delete)", () => {
    // Peer A deleted, Peer B edited -> the edit should win
    const localState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 1000,
      files: {
        "edited.ts": { hash: HASH_B, mtime: 2000, size: 200, lastSyncedHash: HASH_A },
      },
    };
    const remoteManifest: Manifest = {
      version: 2,
      files: {
        "edited.ts": {
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

    const actions = compareSyncState(localState, remoteManifest);

    // Edit wins: the local edit should be uploaded, not deleted
    expect(actions).toContainEqual(
      expect.objectContaining({ path: "edited.ts", action: "upload" }),
    );
  });

  it("returns empty actions when both sides have no files", () => {
    const localState: SyncState = { manifestVersion: 1, lastSyncAt: 1000, files: {} };
    const remoteManifest: Manifest = { version: 2, files: {} };

    const actions = compareSyncState(localState, remoteManifest);

    expect(actions).toHaveLength(0);
  });
});
