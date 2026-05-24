import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  adoptRemoteManifestVersion,
  adoptSyncChangeManifestVersion,
  capSyncStateFiles,
  createDaemonAuthFileAccessors,
  createSerialTaskQueue,
  exitOnAuthFailure,
  parseRemoteManifestEnvelope,
  persistPauseState,
  resolveDaemonAuth,
  resolveWithinSyncRoot,
  writePidFileExclusive,
} from "../../src/daemon/index.js";
import { loadAuth, loadProfileAuth, saveAuth, saveProfileAuth } from "../../src/auth/token-store.js";
import { loadConfig, type SyncConfig } from "../../src/lib/config.js";
import { saveProfiles } from "../../src/lib/profiles.js";
import { AuthRejectedError, VersionConflictError } from "../../src/daemon/r2-client.js";
import type { SyncState } from "../../src/daemon/types.js";

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
