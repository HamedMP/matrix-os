import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hashFile } from "../../src/lib/hash.js";
import { parseSyncIgnore, isIgnored } from "../../src/lib/syncignore.js";
import {
  loadSyncState,
  saveSyncState,
  compareSyncState,
  type SyncState,
} from "../../src/daemon/manifest-cache.js";
import {
  detectChanges,
  buildPresignBatch,
} from "../../src/daemon/sync-engine.js";
import {
  resolveTextConflict,
  resolveBinaryConflict,
  isTextFile,
  generateConflictPath,
} from "../../src/daemon/conflict-resolver.js";
import type { Manifest, ManifestEntry } from "../../src/daemon/types.js";

/**
 * E2E sync cycle smoke test.
 *
 * Simulates two peers (A and B) syncing via a shared R2 manifest.
 * The gateway and R2 are simulated in-memory -- no network calls.
 * Each peer has its own local directory and SyncState.
 * The "gateway" is a plain Manifest object that both peers read/write.
 */

const TEST_DIR = join(import.meta.dirname, ".tmp-e2e-sync");
const PEER_A_DIR = join(TEST_DIR, "peer-a");
const PEER_B_DIR = join(TEST_DIR, "peer-b");
const STATE_A_PATH = join(TEST_DIR, "state-a.json");
const STATE_B_PATH = join(TEST_DIR, "state-b.json");

const ignorePatterns = parseSyncIgnore("");

function sha256(content: string): string {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

let manifest: Manifest;
let manifestVersion: number;

function simulateGatewayCommit(
  path: string,
  hash: string,
  size: number,
  peerId: string,
  opts?: { deleted?: boolean },
): void {
  manifestVersion++;
  if (opts?.deleted) {
    manifest.files[path] = {
      hash,
      size: 0,
      mtime: Date.now(),
      peerId,
      version: manifestVersion,
      deleted: true,
      deletedAt: Date.now(),
    };
  } else {
    manifest.files[path] = {
      hash,
      size,
      mtime: Date.now(),
      peerId,
      version: manifestVersion,
    };
  }
}

beforeEach(async () => {
  await mkdir(PEER_A_DIR, { recursive: true });
  await mkdir(PEER_B_DIR, { recursive: true });
  manifest = { version: 2, files: {} };
  manifestVersion = 0;
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("E2E sync cycle", () => {
  it("Peer A creates file -> upload -> Peer B downloads", async () => {
    // -- Step 1: Peer A creates a file --
    const content = "export function hello() { return 'world'; }\n";
    const filePath = "src/hello.ts";
    await mkdir(join(PEER_A_DIR, "src"), { recursive: true });
    await writeFile(join(PEER_A_DIR, filePath), content);

    // Peer A's daemon watcher detects the new file and hashes it
    const hashA = await hashFile(join(PEER_A_DIR, filePath));
    expect(hashA).toBe(sha256(content));

    // -- Step 2: Watcher triggers direct upload (new files bypass detectChanges) --
    // The watcher's onEvent fires for new files and the daemon directly
    // requests a presigned URL, uploads, and commits. We simulate this path.
    const presignRequest = { path: filePath, action: "put" as const, hash: hashA };
    expect(presignRequest.action).toBe("put");

    // Simulate: file content goes to R2, gateway commits manifest
    simulateGatewayCommit(filePath, hashA, content.length, "peer-a");

    // -- Step 3: Peer A updates local state with lastSyncedHash --
    let stateA: SyncState = await loadSyncState(STATE_A_PATH);
    stateA.files[filePath] = {
      hash: hashA,
      mtime: Date.now(),
      size: content.length,
      lastSyncedHash: hashA,
    };
    stateA.manifestVersion = manifestVersion;
    await saveSyncState(STATE_A_PATH, stateA);

    // -- Step 4: Peer B syncs (receives sync:change event via WebSocket) --
    let stateB: SyncState = await loadSyncState(STATE_B_PATH);
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    expect(changesB.downloads).toContainEqual(
      expect.objectContaining({ path: filePath, hash: hashA }),
    );

    // Peer B builds presign batch for downloads
    const presignB = buildPresignBatch(changesB);
    expect(presignB).toContainEqual(
      expect.objectContaining({ path: filePath, action: "get" }),
    );

    // Peer B "downloads" the file from R2 (simulate by copying content)
    await mkdir(join(PEER_B_DIR, "src"), { recursive: true });
    await writeFile(join(PEER_B_DIR, filePath), content);

    // Verify content matches
    const hashB = await hashFile(join(PEER_B_DIR, filePath));
    expect(hashB).toBe(hashA);

    // Peer B updates local state
    stateB.files[filePath] = {
      hash: hashB,
      mtime: Date.now(),
      size: content.length,
      lastSyncedHash: hashB,
    };
    stateB.manifestVersion = manifestVersion;
    await saveSyncState(STATE_B_PATH, stateB);

    // -- Step 5: Verify both peers are in sync --
    const finalChangesA = detectChanges(stateA, manifest, ignorePatterns);
    const finalChangesB = detectChanges(stateB, manifest, ignorePatterns);

    expect(finalChangesA.uploads).toHaveLength(0);
    expect(finalChangesA.downloads).toHaveLength(0);
    expect(finalChangesB.uploads).toHaveLength(0);
    expect(finalChangesB.downloads).toHaveLength(0);
  });

  it("both peers modify same text file -> 3-way merge succeeds", async () => {
    // -- Setup: file exists on both peers, synced --
    const baseContent = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    const baseHash = sha256(baseContent);
    const filePath = "shared/doc.md";

    for (const dir of [PEER_A_DIR, PEER_B_DIR]) {
      await mkdir(join(dir, "shared"), { recursive: true });
      await writeFile(join(dir, filePath), baseContent);
    }

    simulateGatewayCommit(filePath, baseHash, baseContent.length, "peer-a");

    const baseState = {
      hash: baseHash,
      mtime: Date.now(),
      size: baseContent.length,
      lastSyncedHash: baseHash,
    };

    let stateA: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: { [filePath]: { ...baseState } },
    };
    let stateB: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: { [filePath]: { ...baseState } },
    };

    // -- Peer A modifies line 1, Peer B modifies line 5 --
    const localContentA = "line 1 edited by A\nline 2\nline 3\nline 4\nline 5\n";
    const localContentB = "line 1\nline 2\nline 3\nline 4\nline 5 edited by B\n";

    await writeFile(join(PEER_A_DIR, filePath), localContentA);
    await writeFile(join(PEER_B_DIR, filePath), localContentB);

    const hashA = sha256(localContentA);
    const hashB = sha256(localContentB);

    // Peer A uploads first
    stateA.files[filePath] = { hash: hashA, mtime: Date.now(), size: localContentA.length, lastSyncedHash: baseHash };
    simulateGatewayCommit(filePath, hashA, localContentA.length, "peer-a");
    stateA.files[filePath]!.lastSyncedHash = hashA;

    // Peer B detects conflict: local changed (B edited) and remote changed (A uploaded)
    stateB.files[filePath] = { hash: hashB, mtime: Date.now(), size: localContentB.length, lastSyncedHash: baseHash };
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    expect(changesB.conflicts).toHaveLength(1);
    expect(changesB.conflicts[0]!.path).toBe(filePath);
    expect(changesB.conflicts[0]!.localHash).toBe(hashB);
    expect(changesB.conflicts[0]!.remoteHash).toBe(hashA);

    // -- 3-way merge: changes in different regions should auto-merge --
    expect(isTextFile(filePath)).toBe(true);

    const mergeResult = await resolveTextConflict(
      baseContent,
      localContentB,
      localContentA,
      { filePath, peerId: "peer-a" },
    );

    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.content).toContain("line 1 edited by A");
    expect(mergeResult.content).toContain("line 5 edited by B");
    expect(mergeResult.conflictPath).toBeUndefined();

    // Peer B writes merged result
    await writeFile(join(PEER_B_DIR, filePath), mergeResult.content);
    const mergedHash = sha256(mergeResult.content);

    // Peer B uploads the merged result
    stateB.files[filePath] = {
      hash: mergedHash,
      mtime: Date.now(),
      size: mergeResult.content.length,
      lastSyncedHash: mergedHash,
    };
    simulateGatewayCommit(filePath, mergedHash, mergeResult.content.length, "peer-b");
  });

  it("both peers modify same region -> conflict copy created", async () => {
    const baseContent = "line 1\nline 2\nline 3\n";
    const baseHash = sha256(baseContent);
    const filePath = "shared/config.ts";

    for (const dir of [PEER_A_DIR, PEER_B_DIR]) {
      await mkdir(join(dir, "shared"), { recursive: true });
      await writeFile(join(dir, filePath), baseContent);
    }

    simulateGatewayCommit(filePath, baseHash, baseContent.length, "peer-a");

    const baseState = {
      hash: baseHash,
      mtime: Date.now(),
      size: baseContent.length,
      lastSyncedHash: baseHash,
    };

    let stateB: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: { [filePath]: { ...baseState } },
    };

    // Both peers modify line 2 differently
    const contentA = "line 1\nA's version of line 2\nline 3\n";
    const contentB = "line 1\nB's version of line 2\nline 3\n";

    const hashA = sha256(contentA);
    const hashB = sha256(contentB);

    // Peer A uploads first
    simulateGatewayCommit(filePath, hashA, contentA.length, "peer-a");

    // Peer B detects conflict
    stateB.files[filePath] = { hash: hashB, mtime: Date.now(), size: contentB.length, lastSyncedHash: baseHash };
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    expect(changesB.conflicts).toHaveLength(1);

    // 3-way merge fails (same region changed)
    const mergeResult = await resolveTextConflict(
      baseContent,
      contentB,
      contentA,
      {
        filePath,
        peerId: "peer-a",
        date: new Date("2026-04-14"),
      },
    );

    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.content).toContain("<<<<<<<");
    expect(mergeResult.content).toContain("=======");
    expect(mergeResult.content).toContain(">>>>>>>");
    expect(mergeResult.conflictPath).toBe(
      "shared/config (conflict - peer-a - 2026-04-14).ts",
    );

    // Peer B writes the conflict file with markers
    await writeFile(
      join(PEER_B_DIR, mergeResult.conflictPath!),
      mergeResult.content,
    );

    // Verify both files exist
    const originalContent = await readFile(join(PEER_B_DIR, filePath), "utf-8");
    expect(originalContent).toBe(baseContent);

    const conflictContent = await readFile(
      join(PEER_B_DIR, mergeResult.conflictPath!),
      "utf-8",
    );
    expect(conflictContent).toContain("<<<<<<<");
  });

  it("binary conflict creates conflict copy, preserving original", async () => {
    const filePath = "images/logo.png";
    const localContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    const remoteContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);

    await mkdir(join(PEER_B_DIR, "images"), { recursive: true });
    await writeFile(join(PEER_B_DIR, filePath), localContent);

    expect(isTextFile(filePath)).toBe(false);

    const result = await resolveBinaryConflict({
      filePath,
      syncRoot: PEER_B_DIR,
      remoteContent,
      peerId: "peer-a",
      date: new Date("2026-04-14"),
    });

    expect(result.merged).toBe(false);
    expect(result.conflictPath).toBe(
      "images/logo (conflict - peer-a - 2026-04-14).png",
    );

    // Original preserved
    const preserved = await readFile(join(PEER_B_DIR, filePath));
    expect(preserved).toEqual(localContent);

    // Conflict copy has remote content
    const conflictFile = await readFile(join(PEER_B_DIR, result.conflictPath!));
    expect(conflictFile).toEqual(remoteContent);
  });

  it("Peer A deletes file -> tombstone -> Peer B removes locally", async () => {
    // -- Setup: file exists on both peers, synced --
    const content = "to be deleted\n";
    const contentHash = sha256(content);
    const filePath = "temp/old-file.txt";

    for (const dir of [PEER_A_DIR, PEER_B_DIR]) {
      await mkdir(join(dir, "temp"), { recursive: true });
      await writeFile(join(dir, filePath), content);
    }

    simulateGatewayCommit(filePath, contentHash, content.length, "peer-a");

    const baseFileState = {
      hash: contentHash,
      mtime: Date.now(),
      size: content.length,
      lastSyncedHash: contentHash,
    };

    let stateA: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: { [filePath]: { ...baseFileState } },
    };
    let stateB: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: { [filePath]: { ...baseFileState } },
    };
    await saveSyncState(STATE_A_PATH, stateA);
    await saveSyncState(STATE_B_PATH, stateB);

    // -- Step 1: Peer A deletes the file locally --
    await unlink(join(PEER_A_DIR, filePath));

    // Peer A's watcher detects the unlink. Daemon uses compareSyncState
    // with localDeleted to indicate the watcher saw a delete.
    const actionsA = compareSyncState(stateA, manifest, {
      localDeleted: [filePath],
    });

    expect(actionsA).toContainEqual(
      expect.objectContaining({ path: filePath, action: "delete" }),
    );

    // -- Step 2: Peer A commits the deletion to gateway --
    simulateGatewayCommit(filePath, contentHash, 0, "peer-a", { deleted: true });
    delete stateA.files[filePath];
    stateA.manifestVersion = manifestVersion;
    await saveSyncState(STATE_A_PATH, stateA);

    // -- Step 3: Peer B syncs and sees the tombstone --
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    expect(changesB.deletions).toContainEqual(
      expect.objectContaining({ path: filePath }),
    );

    // Peer B removes the file locally
    await unlink(join(PEER_B_DIR, filePath));
    delete stateB.files[filePath];
    stateB.manifestVersion = manifestVersion;
    await saveSyncState(STATE_B_PATH, stateB);

    // -- Step 4: Verify both peers have no pending changes --
    stateA = await loadSyncState(STATE_A_PATH);
    stateB = await loadSyncState(STATE_B_PATH);

    const finalA = detectChanges(stateA, manifest, ignorePatterns);
    const finalB = detectChanges(stateB, manifest, ignorePatterns);

    expect(finalA.uploads).toHaveLength(0);
    expect(finalA.downloads).toHaveLength(0);
    expect(finalB.uploads).toHaveLength(0);
    expect(finalB.downloads).toHaveLength(0);
  });

  it("full multi-file sync round-trip with ignored files", async () => {
    // Peer A creates three files: one normal, one in node_modules, one .DS_Store
    const files = [
      { path: "src/app.ts", content: "const x = 1;\n" },
      { path: "node_modules/ws/index.js", content: "module.exports = {};\n" },
      { path: ".DS_Store", content: "\x00\x00\x00\x01" },
    ];

    for (const f of files) {
      const dir = join(PEER_A_DIR, f.path, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(join(PEER_A_DIR, f.path), f.content);
    }

    // Watcher filters: only non-ignored files trigger events
    const trackedFiles = files.filter((f) => !isIgnored(f.path, ignorePatterns));
    expect(trackedFiles).toHaveLength(1);
    expect(trackedFiles[0]!.path).toBe("src/app.ts");

    // Ignored files never even enter the watcher event stream
    expect(isIgnored("node_modules/ws/index.js", ignorePatterns)).toBe(true);
    expect(isIgnored(".DS_Store", ignorePatterns)).toBe(true);

    // Simulate: watcher detects app.ts, daemon uploads, manifest updated
    const appHash = sha256(trackedFiles[0]!.content);
    simulateGatewayCommit("src/app.ts", appHash, trackedFiles[0]!.content.length, "peer-a");

    let stateA: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: {
        "src/app.ts": {
          hash: appHash,
          mtime: Date.now(),
          size: trackedFiles[0]!.content.length,
          lastSyncedHash: appHash,
        },
      },
    };

    // After upload, reconciliation shows no pending changes
    const changesA = detectChanges(stateA, manifest, ignorePatterns);
    expect(changesA.uploads).toHaveLength(0);
    expect(changesA.downloads).toHaveLength(0);

    // Peer B syncs: downloads only the tracked file
    const stateB: SyncState = { manifestVersion: 0, lastSyncAt: 0, files: {} };
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    const downloadPaths = changesB.downloads.map((d) => d.path);
    expect(downloadPaths).toContain("src/app.ts");
    expect(downloadPaths).not.toContain("node_modules/ws/index.js");
    expect(downloadPaths).not.toContain(".DS_Store");
  });

  it("delete-edit conflict: local edit wins over remote delete", async () => {
    const baseContent = "original\n";
    const baseHash = sha256(baseContent);
    const filePath = "doc.md";

    simulateGatewayCommit(filePath, baseHash, baseContent.length, "peer-a");

    // Peer B edits the file locally
    const editedContent = "edited by B\n";
    const editedHash = sha256(editedContent);

    let stateB: SyncState = {
      manifestVersion,
      lastSyncAt: Date.now(),
      files: {
        [filePath]: {
          hash: editedHash,
          mtime: Date.now(),
          size: editedContent.length,
          lastSyncedHash: baseHash,
        },
      },
    };

    // Meanwhile, Peer A deletes the file
    simulateGatewayCommit(filePath, baseHash, 0, "peer-a", { deleted: true });

    // Peer B detects: remote is tombstone, but local has edits -> edit wins
    const changesB = detectChanges(stateB, manifest, ignorePatterns);

    // Per spec: "delete-edit conflict: edit wins"
    expect(changesB.uploads).toContainEqual(
      expect.objectContaining({ path: filePath, hash: editedHash }),
    );
    expect(changesB.deletions).toHaveLength(0);
  });

  it("sync state persists across load/save round-trips", async () => {
    const original: SyncState = {
      manifestVersion: 42,
      lastSyncAt: Date.now(),
      files: {
        "readme.md": {
          hash: sha256("hello"),
          mtime: Date.now(),
          size: 5,
          lastSyncedHash: sha256("hello"),
        },
        "src/index.ts": {
          hash: sha256("export {}"),
          mtime: Date.now(),
          size: 9,
        },
      },
    };

    await saveSyncState(STATE_A_PATH, original);
    const loaded = await loadSyncState(STATE_A_PATH);

    expect(loaded.manifestVersion).toBe(42);
    expect(loaded.files["readme.md"]?.hash).toBe(original.files["readme.md"]!.hash);
    expect(loaded.files["readme.md"]?.lastSyncedHash).toBe(
      original.files["readme.md"]!.lastSyncedHash,
    );
    expect(loaded.files["src/index.ts"]?.hash).toBe(
      original.files["src/index.ts"]!.hash,
    );
    // lastSyncedHash is optional, should be undefined if not set
    expect(loaded.files["src/index.ts"]?.lastSyncedHash).toBeUndefined();
  });

  it("manifest entry soft limit warning fires during sync", async () => {
    // Build a manifest with 8000+ entries
    const largeFiles: Record<string, ManifestEntry> = {};
    for (let i = 0; i < 8001; i++) {
      largeFiles[`gen/file-${i}.ts`] = {
        hash: sha256(`content-${i}`),
        size: 100,
        mtime: Date.now(),
        peerId: "peer-a",
        version: 1,
      };
    }
    const largeManifest: Manifest = { version: 2, files: largeFiles };

    const stateB: SyncState = { manifestVersion: 0, lastSyncAt: 0, files: {} };
    const changes = detectChanges(stateB, largeManifest, ignorePatterns);

    expect(changes.warnings.length).toBeGreaterThanOrEqual(1);
    expect(changes.warnings[0]!.code).toBe("manifest_entry_soft_limit");
    expect(changes.warnings[0]!.entryCount).toBeGreaterThanOrEqual(8001);

    // Downloads still work despite the warning
    expect(changes.downloads.length).toBe(8001);
  });
});
