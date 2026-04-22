import { describe, it, expect, vi } from "vitest";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createIpcHandler } from "../../src/daemon/ipc-handler.js";
import type { SyncConfig } from "../../src/lib/config.js";
import type { SyncState } from "../../src/daemon/types.js";

function baseConfig(): SyncConfig {
  return {
    platformUrl: "https://app.example.com",
    gatewayUrl: "https://app.example.com",
    syncPath: join(homedir(), "matrixos"),
    gatewayFolder: "",
    peerId: "host-abcd1234",
    pauseSync: false,
  };
}

function baseState(): SyncState {
  return {
    manifestVersion: 4,
    lastSyncAt: 1234,
    files: {
      "a.md": { hash: "sha256:aa", mtime: 1, size: 1 },
      "b.md": { hash: "sha256:bb", mtime: 2, size: 2 },
    },
  };
}

function createDeps(overrides: Partial<Parameters<typeof createIpcHandler>[0]> = {}) {
  const saveConfig = vi.fn().mockResolvedValue(undefined);
  const persistPauseState = vi.fn(async (cfg: SyncConfig, paused: boolean) => {
    cfg.pauseSync = paused;
  });
  const clearAuth = vi.fn().mockResolvedValue(undefined);
  const exit = vi.fn();
  const ensureDir = vi.fn().mockResolvedValue(undefined);
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const schedule = (fn: () => void, ms: number) => {
    scheduled.push({ fn, ms });
  };
  const logger = { info: vi.fn() };

  const deps = {
    config: baseConfig(),
    syncState: baseState(),
    logger,
    saveConfig,
    persistPauseState,
    clearAuth,
    exit,
    ensureDir,
    schedule,
    ...overrides,
  };
  return { deps, saveConfig, persistPauseState, clearAuth, exit, ensureDir, scheduled, logger };
}

describe("createIpcHandler", () => {
  describe("status", () => {
    it("returns a token-free snapshot of config + syncState", async () => {
      const { deps } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("status", {});

      expect(res).toEqual({
        syncing: true,
        manifestVersion: 4,
        lastSyncAt: 1234,
        fileCount: 2,
        syncPath: deps.config.syncPath,
        gatewayFolder: "",
        gatewayUrl: deps.config.gatewayUrl,
        platformUrl: deps.config.platformUrl,
        peerId: deps.config.peerId,
      });
    });

    it("reports syncing: false when pauseSync is true", async () => {
      const { deps } = createDeps();
      deps.config.pauseSync = true;
      const handler = createIpcHandler(deps);

      const res = await handler("status", {});

      expect(res.syncing).toBe(false);
    });
  });

  describe("pause / resume", () => {
    it("pause flips pauseSync and persists", async () => {
      const { deps, persistPauseState } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("pause", {});

      expect(res).toEqual({ paused: true });
      expect(persistPauseState).toHaveBeenCalledWith(deps.config, true);
    });

    it("resume flips pauseSync back off", async () => {
      const { deps, persistPauseState } = createDeps();
      deps.config.pauseSync = true;
      const handler = createIpcHandler(deps);

      const res = await handler("resume", {});

      expect(res).toEqual({ paused: false });
      expect(persistPauseState).toHaveBeenCalledWith(deps.config, false);
    });
  });

  describe("getConfig", () => {
    it("returns the current persisted config without tokens", async () => {
      const { deps } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("getConfig", {});

      expect(res).toEqual({
        syncPath: deps.config.syncPath,
        gatewayFolder: "",
        gatewayUrl: deps.config.gatewayUrl,
        platformUrl: deps.config.platformUrl,
        peerId: deps.config.peerId,
        pauseSync: false,
      });
      // Defensively assert no leakage of auth-shaped fields.
      expect(res).not.toHaveProperty("accessToken");
      expect(res).not.toHaveProperty("token");
    });

    it("normalizes a missing gatewayFolder to an empty string", async () => {
      const { deps } = createDeps();
      delete (deps.config as Partial<SyncConfig>).gatewayFolder;
      const handler = createIpcHandler(deps);

      const res = await handler("getConfig", {});

      expect(res.gatewayFolder).toBe("");
    });
  });

  describe("setSyncPath", () => {
    it("validates within $HOME, persists, and signals restart", async () => {
      const { deps, saveConfig, ensureDir } = createDeps();
      const handler = createIpcHandler(deps);
      const next = join(homedir(), "matrixos-alt");

      const res = await handler("setSyncPath", { syncPath: next });

      expect(res).toEqual({ syncPath: next, restartRequired: true });
      expect(deps.config.syncPath).toBe(next);
      expect(saveConfig).toHaveBeenCalledWith(deps.config);
      expect(ensureDir).toHaveBeenCalledWith(next);
    });

    it("rejects paths that escape $HOME", async () => {
      const { deps, saveConfig } = createDeps();
      const handler = createIpcHandler(deps);

      await expect(
        handler("setSyncPath", { syncPath: "/etc/passwd" }),
      ).rejects.toThrow(/home directory/i);
      expect(saveConfig).not.toHaveBeenCalled();
    });

    it("rejects a missing / blank syncPath arg", async () => {
      const { deps, saveConfig } = createDeps();
      const handler = createIpcHandler(deps);

      await expect(handler("setSyncPath", {})).rejects.toThrow(/required/i);
      await expect(
        handler("setSyncPath", { syncPath: "   " }),
      ).rejects.toThrow(/required/i);
      expect(saveConfig).not.toHaveBeenCalled();
    });

    it("actually creates the directory on disk when no ensureDir override is passed", async () => {
      const { deps, saveConfig } = createDeps({ ensureDir: undefined });
      // Use a unique dir inside $HOME so resolveSyncPathWithinHome accepts it.
      const inHome = join(homedir(), `.matrixos-ipc-test-${Date.now()}`);
      const handler = createIpcHandler(deps);
      try {
        const res = await handler("setSyncPath", { syncPath: inHome });
        expect(res.syncPath).toBe(inHome);
        expect(existsSync(inHome)).toBe(true);
        expect(saveConfig).toHaveBeenCalled();
      } finally {
        await rm(inHome, { recursive: true, force: true });
      }
    });
  });

  describe("setGatewayFolder", () => {
    it("normalizes and persists a new folder", async () => {
      const { deps, saveConfig } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("setGatewayFolder", { gatewayFolder: "audit/" });

      expect(res).toEqual({ gatewayFolder: "audit", restartRequired: true });
      expect(deps.config.gatewayFolder).toBe("audit");
      expect(saveConfig).toHaveBeenCalledWith(deps.config);
    });

    it("rejects folders that start with a leading slash", async () => {
      const { deps, saveConfig } = createDeps();
      const handler = createIpcHandler(deps);

      await expect(
        handler("setGatewayFolder", { gatewayFolder: "/audit" }),
      ).rejects.toThrow(/must not start with/i);
      expect(saveConfig).not.toHaveBeenCalled();
    });

    it("accepts an empty folder (full-mirror mode)", async () => {
      const { deps, saveConfig } = createDeps();
      deps.config.gatewayFolder = "audit";
      const handler = createIpcHandler(deps);

      const res = await handler("setGatewayFolder", { gatewayFolder: "" });

      expect(res).toEqual({ gatewayFolder: "", restartRequired: true });
      expect(deps.config.gatewayFolder).toBe("");
      expect(saveConfig).toHaveBeenCalled();
    });

    it("rejects traversal via '..' segments", async () => {
      const { deps, saveConfig } = createDeps();
      const handler = createIpcHandler(deps);

      await expect(
        handler("setGatewayFolder", { gatewayFolder: "../../etc" }),
      ).rejects.toThrow(/\.\./);
      expect(saveConfig).not.toHaveBeenCalled();
    });
  });

  describe("restart", () => {
    it("schedules exit(3) and returns immediately", async () => {
      const { deps, exit, scheduled, logger } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("restart", {});

      expect(res).toEqual({ restarting: true });
      expect(exit).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(1);

      scheduled[0]!.fn();
      expect(logger.info).toHaveBeenCalledWith("Restart requested via IPC");
      expect(exit).toHaveBeenCalledWith(3);
    });
  });

  describe("logout", () => {
    it("clears auth, schedules exit(0), and returns immediately", async () => {
      const { deps, clearAuth, exit, scheduled, logger } = createDeps();
      const handler = createIpcHandler(deps);

      const res = await handler("logout", {});

      expect(res).toEqual({ loggedOut: true });
      expect(clearAuth).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      scheduled[0]!.fn();
      expect(logger.info).toHaveBeenCalledWith("Logout requested via IPC");
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  describe("unknown command", () => {
    it("rejects with a descriptive error", async () => {
      const { deps } = createDeps();
      const handler = createIpcHandler(deps);

      await expect(handler("nope", {})).rejects.toThrow(/Unknown command/);
    });
  });

  describe("getConfig after setGatewayFolder", () => {
    it("reflects the updated folder in subsequent getConfig calls", async () => {
      // Regression: the handler must update the same config object the
      // daemon is holding a reference to; cloning it breaks this.
      const { deps } = createDeps();
      const handler = createIpcHandler(deps);

      await handler("setGatewayFolder", { gatewayFolder: "notes" });
      const res = await handler("getConfig", {});

      expect(res.gatewayFolder).toBe("notes");
    });
  });

  describe("getConfig after setSyncPath", () => {
    it("reflects the updated path in subsequent getConfig / status calls", async () => {
      const { deps } = createDeps();
      const handler = createIpcHandler(deps);
      const next = join(homedir(), `matrixos-new-${Date.now()}`);

      await handler("setSyncPath", { syncPath: next });
      const status = await handler("status", {});
      const cfg = await handler("getConfig", {});

      expect(status.syncPath).toBe(next);
      expect(cfg.syncPath).toBe(next);
    });
  });
});
