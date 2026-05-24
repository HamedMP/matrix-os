import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  adoptRemoteManifestVersion,
  adoptSyncChangeManifestVersion,
  capLoadedSyncState,
  capSyncStateConflicts,
  capSyncStateFiles,
  createDaemonAuthFileAccessors,
  createSerialTaskQueue,
  exitOnAuthFailure,
  parseRemoteManifestEnvelope,
  persistPauseState,
  reconcileRemoteDelete,
  reconcileRemoteFileChange,
  resolveDaemonAuth,
  resolveWithinSyncRoot,
  shouldCommitWatcherDelete,
  shouldSkipWatcherUpload,
  writePidFileExclusive,
} from "../../src/daemon/index.js";
import { loadAuth, loadProfileAuth, saveAuth, saveProfileAuth } from "../../src/auth/token-store.js";
import { loadConfig, type SyncConfig } from "../../src/lib/config.js";
import { saveProfiles } from "../../src/lib/profiles.js";
import { AuthRejectedError, VersionConflictError } from "../../src/daemon/r2-client.js";
import { SyncStateSchema, type SyncState } from "../../src/daemon/types.js";

function sha256(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("daemon runtime guards", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-sync-daemon-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves in-root paths", () => {
    expect(resolveWithinSyncRoot(tempDir, "notes/today.md")).toBe(
      join(tempDir, "notes/today.md"),
    );
  });

  it("rejects traversal outside the sync root", () => {
    expect(() => resolveWithinSyncRoot(tempDir, "../../.ssh/authorized_keys")).toThrow(
      "Remote event path escapes sync root",
    );
  });

  it("creates the pid file exclusively", async () => {
    const pidPath = join(tempDir, "daemon.pid");

    await writePidFileExclusive(pidPath, 4242);

    expect(await readFile(pidPath, "utf-8")).toBe("4242");
  });

  it("rejects a live daemon pid", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    await writeFile(pidPath, "1111");
    vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(writePidFileExclusive(pidPath, 4242)).rejects.toThrow(
      "Sync daemon already running",
    );
  });

  it("replaces a stale pid file", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    await writeFile(pidPath, "1111");
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    await writePidFileExclusive(pidPath, 4242);

    expect(await readFile(pidPath, "utf-8")).toBe("4242");
  });

  it("persists pause state changes", async () => {
    const configPath = join(tempDir, "config.json");
    const config: SyncConfig = {
      platformUrl: "https://platform.matrix-os.com",
      gatewayUrl: "https://app.matrix-os.com",
      syncPath: join(tempDir, "sync"),
      gatewayFolder: "",
      peerId: "test-peer",
      pauseSync: false,
    };
    await mkdir(config.syncPath, { recursive: true });

    await persistPauseState(config, true, configPath);

    expect(config.pauseSync).toBe(true);
    await expect(loadConfig(configPath)).resolves.toMatchObject({ pauseSync: true });
  });

  it("loads daemon auth from the config-selected profile", async () => {
    await saveProfiles({
      active: "cloud",
      profiles: {
        cloud: {
          platformUrl: "https://app.matrix-os.com",
          gatewayUrl: "https://app.matrix-os.com",
        },
        local: {
          platformUrl: "http://localhost:9000",
          gatewayUrl: "http://localhost:4000",
        },
      },
    }, tempDir);
    await saveProfileAuth("local", {
      accessToken: "local-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_dev",
      handle: "dev",
    }, tempDir);

    await expect(resolveDaemonAuth({ profile: "local" }, tempDir)).resolves.toMatchObject({
      auth: { accessToken: "local-token" },
      profileName: "local",
      source: "profile",
    });
  });

  it("loads pinned daemon auth without parsing the active profile registry", async () => {
    await writeFile(join(tempDir, "profiles.json"), "{not valid json");
    await saveProfileAuth("local", {
      accessToken: "local-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_dev",
      handle: "dev",
    }, tempDir);

    await expect(resolveDaemonAuth({ profile: "local" }, tempDir)).resolves.toMatchObject({
      auth: { accessToken: "local-token" },
      profileName: "local",
      source: "profile",
    });
  });

  it("surfaces a malformed unpinned profile registry even when legacy auth exists", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await writeFile(join(tempDir, "profiles.json"), "{not valid json");
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);

    await expect(resolveDaemonAuth({}, tempDir)).rejects.toThrow(SyntaxError);
  });

  it("surfaces profile name conflicts even when legacy auth exists", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await writeFile(join(tempDir, "profiles.json"), JSON.stringify({
      active: "cloud",
      profiles: {
        cloud: {
          platformUrl: "https://app.matrix-os.com",
          gatewayUrl: "https://app.matrix-os.com",
        },
        Cloud: {
          platformUrl: "https://app.matrix-os.com",
          gatewayUrl: "https://app.matrix-os.com",
        },
      },
    }));
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);

    await expect(resolveDaemonAuth({}, tempDir)).rejects.toMatchObject({
      code: "profile_name_conflict",
    });
  });

  it("falls back to legacy global auth when the default active profile has no auth", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);

    await expect(resolveDaemonAuth({}, tempDir)).resolves.toMatchObject({
      auth: { accessToken: "legacy-token" },
      profileName: "cloud",
      source: "legacy",
    });
  });

  it("falls back to legacy global auth when the selected profile has no auth", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await saveProfiles({
      active: "local",
      profiles: {
        cloud: {
          platformUrl: "https://app.matrix-os.com",
          gatewayUrl: "https://app.matrix-os.com",
        },
        local: {
          platformUrl: "http://localhost:9000",
          gatewayUrl: "http://localhost:4000",
        },
      },
    }, tempDir);
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);

    await expect(resolveDaemonAuth({ profile: "local" }, tempDir)).resolves.toMatchObject({
      auth: { accessToken: "legacy-token" },
      profileName: "local",
      source: "legacy",
    });
    await expect(readFile(legacyAuthPath, "utf-8")).resolves.toContain("legacy-token");
  });

  it("uses legacy auth storage for daemon IPC when startup resolved legacy auth", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);

    const accessors = createDaemonAuthFileAccessors({
      profileName: "local",
      source: "legacy",
    }, tempDir);

    await expect(accessors.loadAuth()).resolves.toMatchObject({
      accessToken: "legacy-token",
    });
    await accessors.clearAuth();

    await expect(loadAuth(legacyAuthPath)).resolves.toBeNull();
  });

  it("uses profile auth storage for daemon IPC when startup resolved profile auth", async () => {
    const legacyAuthPath = join(tempDir, "auth.json");
    await saveAuth({
      accessToken: "legacy-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_legacy",
      handle: "legacy",
    }, legacyAuthPath);
    await saveProfileAuth("local", {
      accessToken: "local-token",
      expiresAt: Date.now() + 60_000,
      userId: "user_dev",
      handle: "dev",
    }, tempDir);

    const accessors = createDaemonAuthFileAccessors({
      profileName: "local",
      source: "profile",
    }, tempDir);

    await expect(accessors.loadAuth()).resolves.toMatchObject({
      accessToken: "local-token",
    });
    await accessors.clearAuth();

    await expect(loadProfileAuth("local", tempDir)).resolves.toBeNull();
    await expect(loadAuth(legacyAuthPath)).resolves.toMatchObject({
      accessToken: "legacy-token",
    });
  });

  it("logs serial queue task failures and keeps later tasks running", async () => {
    const onError = vi.fn();
    const enqueue = createSerialTaskQueue(onError);
    const events: string[] = [];

    await expect(
      enqueue(async () => {
        events.push("first");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      enqueue(async () => {
        events.push("second");
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["first", "second"]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("adopts the gateway manifest version after a conflict", async () => {
    const syncState: SyncState = {
      manifestVersion: 3,
      lastSyncAt: 0,
      files: {},
    };

    const adopted = await adoptRemoteManifestVersion(
      syncState,
      new VersionConflictError(3, 7),
      async () => undefined,
    );

    expect(adopted).toBe(true);
    expect(syncState.manifestVersion).toBe(7);
  });

  it("adopts sync-change manifest versions when no local file processing was needed", async () => {
    const syncState: SyncState = {
      manifestVersion: 3,
      lastSyncAt: 0,
      files: {},
    };
    const persist = vi.fn(async () => undefined);

    const adopted = await adoptSyncChangeManifestVersion(
      syncState,
      { manifestVersion: 9 },
      true,
      persist,
    );

    expect(adopted).toBe(true);
    expect(syncState.manifestVersion).toBe(9);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not adopt sync-change manifest versions after local processing fails", async () => {
    const syncState: SyncState = {
      manifestVersion: 3,
      lastSyncAt: 0,
      files: {},
    };
    const persist = vi.fn(async () => undefined);

    const adopted = await adoptSyncChangeManifestVersion(
      syncState,
      { manifestVersion: 9 },
      false,
      persist,
    );

    expect(adopted).toBe(false);
    expect(syncState.manifestVersion).toBe(3);
    expect(persist).not.toHaveBeenCalled();
  });

  it("caps syncState.files to the most recent 50k entries", () => {
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {},
    };

    for (let i = 0; i < 50_002; i++) {
      syncState.files[`file-${i}.txt`] = {
        hash: `sha256:${"a".repeat(63)}${i % 10}`,
        mtime: i,
        size: i,
      };
    }

    const trimmed = capSyncStateFiles(syncState);

    expect(trimmed).toBe(true);
    expect(Object.keys(syncState.files)).toHaveLength(50_000);
    expect(syncState.files["file-0.txt"]).toBeUndefined();
    expect(syncState.files["file-1.txt"]).toBeUndefined();
    expect(syncState.files["file-50001.txt"]).toBeDefined();
  });

  it("caps files and conflicts together after loading sync state", () => {
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {},
      conflicts: {},
    };

    for (let i = 0; i < 50_002; i++) {
      syncState.files[`file-${i}.txt`] = {
        hash: `sha256:${"a".repeat(63)}${i % 10}`,
        mtime: i,
        size: i,
      };
    }
    for (let i = 0; i < 502; i++) {
      syncState.conflicts![`conflict-${i}.txt`] = {
        path: `conflict-${i}.txt`,
        conflictPath: `conflict-${i} (conflict).txt`,
        localHash: `sha256:${"a".repeat(63)}${i % 10}`,
        remoteHash: `sha256:${"b".repeat(63)}${i % 10}`,
        remotePeerId: "peer",
        detectedAt: i,
        resolved: false,
      };
    }

    const trimmed = capLoadedSyncState(syncState);

    expect(trimmed).toBe(true);
    expect(Object.keys(syncState.files)).toHaveLength(50_000);
    expect(Object.keys(syncState.conflicts ?? {})).toHaveLength(500);
    expect(syncState.files["file-0.txt"]).toBeUndefined();
    expect(syncState.conflicts?.["conflict-0.txt"]).toBeUndefined();
  });

  it("preserves local edits and writes remote content to a conflict copy", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localRel = "note.md";
    const remotePath = "note.md";
    const localPath = join(syncRoot, localRel);
    const baseContent = "hello from base\n";
    const localContent = "hello from LOCAL EDIT\n";
    const remoteContent = "hello from REMOTE EDIT\n";
    await writeFile(localPath, localContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        [remotePath]: {
          hash: sha256(localContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(localContent),
          lastSyncedHash: sha256(baseContent),
        },
      },
    };
    let reservedBeforeDownload = false;

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel,
      remotePath,
      remoteHash: sha256(remoteContent),
      remoteSize: Buffer.byteLength(remoteContent),
      remotePeerId: "peer/with/slashes",
      date: new Date("2026-05-20T12:00:00Z"),
      downloadRemote: async (targetPath) => {
        reservedBeforeDownload = (await readFile(targetPath, "utf-8")) === "";
        await writeFile(targetPath, remoteContent);
      },
    });

    expect(result.status).toBe("conflict-created");
    expect(reservedBeforeDownload).toBe(true);
    expect(await readFile(localPath, "utf-8")).toBe(localContent);
    expect(await readFile(join(syncRoot, "note (conflict - peer_with_slashes - 2026-05-20).md"), "utf-8")).toBe(remoteContent);
    expect(syncState.files[remotePath]).toMatchObject({
      hash: sha256(localContent),
      lastSyncedHash: sha256(remoteContent),
    });
    expect(syncState.files["note (conflict - peer_with_slashes - 2026-05-20).md"]).toMatchObject({
      hash: sha256(remoteContent),
      lastSyncedHash: sha256(remoteContent),
      localOnly: true,
    });
    expect(shouldSkipWatcherUpload(
      syncState.files["note (conflict - peer_with_slashes - 2026-05-20).md"],
      sha256(remoteContent),
    )).toBe(true);
    expect(shouldCommitWatcherDelete(
      syncState.files["note (conflict - peer_with_slashes - 2026-05-20).md"],
    )).toBe(false);
    expect(syncState.conflicts?.[remotePath]).toMatchObject({
      path: remotePath,
      conflictPath: "note (conflict - peer_with_slashes - 2026-05-20).md",
      localHash: sha256(localContent),
      remoteHash: sha256(remoteContent),
      remotePeerId: "peer/with/slashes",
      resolved: false,
    });
  });

  it("does not overwrite an earlier conflict copy for the same file and peer", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localRel = "note.md";
    const remotePath = "note.md";
    const localPath = join(syncRoot, localRel);
    const existingConflictPath = join(
      syncRoot,
      "note (conflict - peer-2 - 2026-05-20).md",
    );
    const baseContent = "base\n";
    const localContent = "local edit\n";
    const firstRemoteContent = "first remote edit\n";
    const secondRemoteContent = "second remote edit\n";
    await writeFile(localPath, localContent);
    await writeFile(existingConflictPath, firstRemoteContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        [remotePath]: {
          hash: sha256(localContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(localContent),
          lastSyncedHash: sha256(baseContent),
        },
      },
    };

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel,
      remotePath,
      remoteHash: sha256(secondRemoteContent),
      remoteSize: Buffer.byteLength(secondRemoteContent),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
      downloadRemote: async (targetPath) => {
        await writeFile(targetPath, secondRemoteContent);
      },
    });

    expect(result.status).toBe("conflict-created");
    expect(result.conflictPath).toBe("note (conflict - peer-2 - 2026-05-20) 2.md");
    expect(await readFile(existingConflictPath, "utf-8")).toBe(firstRemoteContent);
    expect(
      await readFile(
        join(syncRoot, "note (conflict - peer-2 - 2026-05-20) 2.md"),
        "utf-8",
      ),
    ).toBe(secondRemoteContent);
  });

  it("does not create duplicate conflict copies for replayed remote revisions", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localRel = "note.md";
    const remotePath = "note.md";
    const localPath = join(syncRoot, localRel);
    const conflictRel = "note (conflict - peer-2 - 2026-05-20).md";
    const conflictPath = join(syncRoot, conflictRel);
    const localContent = "local edit\n";
    const remoteContent = "remote edit\n";
    await writeFile(localPath, localContent);
    await writeFile(conflictPath, remoteContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        [remotePath]: {
          hash: sha256(localContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(localContent),
          lastSyncedHash: sha256(remoteContent),
        },
        [conflictRel]: {
          hash: sha256(remoteContent),
          mtime: (await stat(conflictPath)).mtimeMs,
          size: Buffer.byteLength(remoteContent),
          lastSyncedHash: sha256(remoteContent),
          localOnly: true,
        },
      },
      conflicts: {
        [remotePath]: {
          path: remotePath,
          conflictPath: conflictRel,
          localHash: sha256(localContent),
          remoteHash: sha256(remoteContent),
          remotePeerId: "peer-2",
          detectedAt: new Date("2026-05-20T12:00:00Z").getTime(),
          resolved: false,
        },
      },
    };
    const downloadRemote = vi.fn(async (targetPath: string) => {
      await writeFile(targetPath, remoteContent);
    });

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel,
      remotePath,
      remoteHash: sha256(remoteContent),
      remoteSize: Buffer.byteLength(remoteContent),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
      downloadRemote,
    });

    expect(result.status).toBe("conflict-existing");
    expect(result.conflictPath).toBe(conflictRel);
    expect(downloadRemote).not.toHaveBeenCalled();
    await expect(
      readFile(join(syncRoot, "note (conflict - peer-2 - 2026-05-20) 2.md"), "utf-8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(syncState.conflicts?.[remotePath]).toMatchObject({
      conflictPath: conflictRel,
      remoteHash: sha256(remoteContent),
      resolved: false,
    });
  });

  it("keeps the original download error when conflict cleanup fails", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localRel = "note.md";
    const remotePath = "note.md";
    const localPath = join(syncRoot, localRel);
    const baseContent = "base\n";
    const localContent = "local edit\n";
    const remoteContent = "remote edit\n";
    await writeFile(localPath, localContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        [remotePath]: {
          hash: sha256(localContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(localContent),
          lastSyncedHash: sha256(baseContent),
        },
      },
    };
    const downloadError = new Error("download failed");
    const onCleanupError = vi.fn();

    await expect(reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel,
      remotePath,
      remoteHash: sha256(remoteContent),
      remoteSize: Buffer.byteLength(remoteContent),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
      onConflictCleanupError: onCleanupError,
      downloadRemote: async (targetPath) => {
        await rm(targetPath);
        await mkdir(targetPath);
        throw downloadError;
      },
    })).rejects.toBe(downloadError);

    expect(onCleanupError).toHaveBeenCalledTimes(1);
    expect(onCleanupError.mock.calls[0]?.[0]).toMatchObject({
      code: expect.any(String),
    });
    expect(onCleanupError.mock.calls[0]?.[1]).toBe(
      "note (conflict - peer-2 - 2026-05-20).md",
    );
    expect(syncState.conflicts).toBeUndefined();
    expect(syncState.files[remotePath]).toMatchObject({
      hash: sha256(localContent),
      lastSyncedHash: sha256(baseContent),
    });
  });

  it("replaces local content when local still matches lastSyncedHash", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localPath = join(syncRoot, "note.md");
    const baseContent = "hello from base\n";
    const remoteContent = "hello from REMOTE EDIT\n";
    await writeFile(localPath, baseContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        "note.md": {
          hash: sha256(baseContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(baseContent),
          lastSyncedHash: sha256(baseContent),
        },
      },
    };

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel: "note.md",
      remotePath: "note.md",
      remoteHash: sha256(remoteContent),
      remoteSize: Buffer.byteLength(remoteContent),
      remotePeerId: "peer-2",
      downloadRemote: async (targetPath) => {
        await writeFile(targetPath, remoteContent);
      },
    });

    expect(result.status).toBe("downloaded");
    expect(await readFile(localPath, "utf-8")).toBe(remoteContent);
    expect(syncState.files["note.md"]).toMatchObject({
      hash: sha256(remoteContent),
      lastSyncedHash: sha256(remoteContent),
    });
    expect(syncState.conflicts).toBeUndefined();
  });

  it("downloads remote content when the local file is missing", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const remoteContent = "remote-only\n";
    const syncState: SyncState = { manifestVersion: 1, lastSyncAt: 0, files: {} };

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel: "nested/note.md",
      remotePath: "nested/note.md",
      remoteHash: sha256(remoteContent),
      remoteSize: Buffer.byteLength(remoteContent),
      remotePeerId: "peer-2",
      downloadRemote: async (targetPath) => {
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, remoteContent);
      },
    });

    expect(result.status).toBe("downloaded");
    expect(await readFile(join(syncRoot, "nested/note.md"), "utf-8")).toBe(remoteContent);
    expect(syncState.files["nested/note.md"]).toMatchObject({
      hash: sha256(remoteContent),
      lastSyncedHash: sha256(remoteContent),
    });
  });

  it("marks equal local and remote hashes as synced without downloading", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const content = "same\n";
    await writeFile(join(syncRoot, "note.md"), content);
    const syncState: SyncState = { manifestVersion: 1, lastSyncAt: 0, files: {} };
    const downloadRemote = vi.fn();

    const result = await reconcileRemoteFileChange(syncState, {
      syncRoot,
      localRel: "note.md",
      remotePath: "note.md",
      remoteHash: sha256(content),
      remoteSize: Buffer.byteLength(content),
      remotePeerId: "peer-2",
      downloadRemote,
    });

    expect(result.status).toBe("already-synced");
    expect(downloadRemote).not.toHaveBeenCalled();
    expect(syncState.files["note.md"]).toMatchObject({
      hash: sha256(content),
      lastSyncedHash: sha256(content),
    });
  });

  it("deletes local content when a remote delete targets an unchanged file", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const content = "synced\n";
    const localPath = join(syncRoot, "note.md");
    await writeFile(localPath, content);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        "note.md": {
          hash: sha256(content),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(content),
          lastSyncedHash: sha256(content),
        },
      },
    };

    const result = await reconcileRemoteDelete(syncState, {
      syncRoot,
      localRel: "note.md",
      remotePath: "note.md",
      remoteHash: sha256(content),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
    });

    expect(result.status).toBe("deleted-local");
    await expect(readFile(localPath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(syncState.files["note.md"]).toBeUndefined();
  });

  it("keeps locally edited content when a remote delete conflicts", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const baseContent = "base\n";
    const localContent = "local edit\n";
    const localPath = join(syncRoot, "note.md");
    await writeFile(localPath, localContent);
    const localStat = await stat(localPath);
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        "note.md": {
          hash: sha256(localContent),
          mtime: localStat.mtimeMs,
          size: Buffer.byteLength(localContent),
          lastSyncedHash: sha256(baseContent),
        },
      },
    };

    const result = await reconcileRemoteDelete(syncState, {
      syncRoot,
      localRel: "note.md",
      remotePath: "note.md",
      remoteHash: sha256(baseContent),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
    });

    expect(result.status).toBe("delete-skipped-conflict");
    expect(result.conflictPath).toBeUndefined();
    expect(await readFile(localPath, "utf-8")).toBe(localContent);
    expect(syncState.files["note.md"]).toMatchObject({
      hash: sha256(localContent),
      lastSyncedHash: sha256(baseContent),
    });
    expect(syncState.conflicts?.["note.md"]).toMatchObject({
      path: "note.md",
      localHash: sha256(localContent),
      remoteHash: sha256(baseContent),
      remotePeerId: "peer-2",
    });
    expect(syncState.conflicts?.["note.md"]?.conflictPath).toBeUndefined();
  });

  it("keeps local content on remote delete when there is no cached base hash", async () => {
    const syncRoot = join(tempDir, "sync");
    await mkdir(syncRoot, { recursive: true });
    const localContent = "unsynced local file\n";
    const remoteContent = "remote file that got deleted\n";
    const localPath = join(syncRoot, "note.md");
    await writeFile(localPath, localContent);
    const syncState: SyncState = { manifestVersion: 1, lastSyncAt: 0, files: {} };

    const result = await reconcileRemoteDelete(syncState, {
      syncRoot,
      localRel: "note.md",
      remotePath: "note.md",
      remoteHash: sha256(remoteContent),
      remotePeerId: "peer-2",
      date: new Date("2026-05-20T12:00:00Z"),
    });

    expect(result.status).toBe("delete-skipped-conflict");
    expect(await readFile(localPath, "utf-8")).toBe(localContent);
    expect(syncState.files["note.md"]).toMatchObject({
      hash: sha256(localContent),
      lastSyncedHash: undefined,
    });
  });

  it("caps syncState.conflicts to the most recent 500 entries", () => {
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {},
      conflicts: {},
    };

    for (let i = 0; i < 502; i++) {
      syncState.conflicts![`file-${i}.txt`] = {
        path: `file-${i}.txt`,
        conflictPath: `file-${i} (conflict).txt`,
        localHash: `sha256:${"a".repeat(63)}${i % 10}`,
        remoteHash: `sha256:${"b".repeat(63)}${i % 10}`,
        remotePeerId: "peer",
        detectedAt: i,
        resolved: false,
      };
    }

    const trimmed = capSyncStateConflicts(syncState);

    expect(trimmed).toBe(true);
    expect(Object.keys(syncState.conflicts ?? {})).toHaveLength(500);
    expect(syncState.conflicts?.["file-0.txt"]).toBeUndefined();
    expect(syncState.conflicts?.["file-1.txt"]).toBeUndefined();
    expect(syncState.conflicts?.["file-501.txt"]).toBeDefined();
  });

  it("rejects malformed conflict hashes in sync state", () => {
    const parsed = SyncStateSchema.safeParse({
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {},
      conflicts: {
        "note.md": {
          path: "note.md",
          conflictPath: "note.conflict.md",
          localHash: "not-a-hash",
          remoteHash: `sha256:${"a".repeat(64)}`,
          remotePeerId: "peer-2",
          detectedAt: 0,
          resolved: false,
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("loads old sync state files without conflicts", async () => {
    const statePath = join(tempDir, "sync-state.json");
    await writeFile(statePath, JSON.stringify({
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {},
    }));

    const { loadSyncState } = await import("../../src/daemon/manifest-cache.js");
    await expect(loadSyncState(statePath)).resolves.toMatchObject({
      manifestVersion: 1,
      files: {},
    });
  });

  it("rejects malformed remote manifest envelopes", () => {
    expect(() =>
      parseRemoteManifestEnvelope({
        manifestVersion: "7",
        manifest: { files: {} },
      }),
    ).toThrow("Invalid remote manifest response");
  });

  it("exits cleanly on auth rejection errors", () => {
    const logger = { error: vi.fn() };
    const exit = vi.fn();

    const handled = exitOnAuthFailure(new AuthRejectedError(), logger, exit);

    expect(handled).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "Auth token rejected or expired. Re-run `matrixos login`.",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
