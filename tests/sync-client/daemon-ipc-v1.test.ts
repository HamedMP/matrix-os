import { describe, expect, it, vi } from "vitest";
import {
  DaemonRequestSchema,
  formatDaemonError,
  formatDaemonSuccess,
  parseDaemonRequest,
} from "../../packages/sync-client/src/daemon/types.js";
import { createIpcHandler } from "../../packages/sync-client/src/daemon/ipc-handler.js";

describe("daemon IPC v1 envelopes", () => {
  it("requires protocol version 1 and bounded command names", () => {
    expect(DaemonRequestSchema.parse({ id: "1", v: 1, command: "shell.list", args: {} }).command).toBe("shell.list");
    expect(() => DaemonRequestSchema.parse({ id: "1", command: "shell.list", args: {} })).toThrow();
  });

  it("returns stable errors for unknown commands", () => {
    expect(parseDaemonRequest({ id: "1", v: 1, command: "unknown", args: {} })).toEqual({
      ok: false,
      response: formatDaemonError("1", "unknown_command"),
    });
  });

  it("returns stable errors for unsupported versions", () => {
    expect(parseDaemonRequest({ id: "1", v: 2, command: "shell.list", args: {} })).toEqual({
      ok: false,
      response: formatDaemonError("1", "unsupported_version"),
    });
  });

  it("formats versioned success envelopes", () => {
    expect(formatDaemonSuccess("1", { sessions: [] })).toEqual({
      id: "1",
      v: 1,
      result: { sessions: [] },
    });
  });

  it("dispatches auth and shell control commands through v1 dependencies", async () => {
    const shell = {
      listSessions: async () => [{ name: "main" }],
      createSession: async (input: Record<string, unknown>) => ({ ...input, created: true }),
      deleteSession: async () => undefined,
    };
    const handler = createIpcHandler({
      config: baseConfig(),
      syncState: baseSyncState(),
      logger: { info: () => undefined },
      saveConfig: async () => undefined,
      persistPauseState: async () => undefined,
      clearAuth: async () => undefined,
      exit: () => undefined,
      loadAuth: async () => ({
        accessToken: "tok",
        expiresAt: 4102444800000,
        userId: "user_1",
        handle: "neo",
      }),
      shell,
    });

    await expect(handler("auth.whoami", {})).resolves.toEqual({
      authenticated: true,
      userId: "user_1",
      handle: "neo",
    });
    await expect(handler("auth.token", {})).resolves.toEqual({
      accessToken: "tok",
      expiresAt: 4102444800000,
    });
    await expect(handler("shell.list", {})).resolves.toEqual({ sessions: [{ name: "main" }] });
    await expect(handler("shell.create", { name: "main" })).resolves.toEqual({ name: "main", created: true });
    await expect(handler("shell.destroy", { name: "main" })).resolves.toEqual({ ok: true });
  });

  it("validates shell IPC payloads before dispatching to the REST client", async () => {
    const shell = {
      createSession: vi.fn(async (input: Record<string, unknown>) => ({ ...input, created: true })),
    };
    const handler = createIpcHandler({
      config: baseConfig(),
      syncState: baseSyncState(),
      logger: { info: () => undefined },
      saveConfig: async () => undefined,
      persistPauseState: async () => undefined,
      clearAuth: async () => undefined,
      exit: () => undefined,
      shell,
    });

    await expect(handler("shell.create", { name: "../main", cwd: "../outside" })).rejects.toThrow("invalid_request");
    expect(shell.createSession).not.toHaveBeenCalled();
  });

  it("dispatches tab, pane, layout, and sync v1 aliases", async () => {
    const handler = createIpcHandler({
      config: baseConfig(),
      syncState: baseSyncState(),
      logger: { info: () => undefined },
      saveConfig: async () => undefined,
      persistPauseState: async () => undefined,
      clearAuth: async () => undefined,
      exit: () => undefined,
      shell: {
        listTabs: async () => [{ idx: 0, name: "main" }],
        createTab: async () => ({ ok: true }),
        switchTab: async () => ({ ok: true }),
        closeTab: async () => ({ ok: true }),
        splitPane: async () => ({ paneId: "pane-2" }),
        closePane: async () => ({ ok: true }),
        listLayouts: async () => [{ name: "dev" }],
        showLayout: async () => ({ name: "dev", kdl: "layout {}" }),
        saveLayout: async () => ({ ok: true }),
        applyLayout: async () => ({ ok: true }),
        deleteLayout: async () => ({ ok: true }),
      },
    });

    await expect(handler("tab.list", { session: "main" })).resolves.toEqual({ tabs: [{ idx: 0, name: "main" }] });
    await expect(handler("pane.split", { session: "main", direction: "right" })).resolves.toEqual({ paneId: "pane-2" });
    await expect(handler("layout.list", {})).resolves.toEqual({ layouts: [{ name: "dev" }] });
    await expect(handler("sync.status", {})).resolves.toMatchObject({ syncing: true, fileCount: 0 });
    await expect(handler("sync.pause", {})).resolves.toEqual({ paused: true });
    await expect(handler("sync.resume", {})).resolves.toEqual({ paused: false });
  });
});

function baseConfig() {
  return {
    gatewayUrl: "https://gateway.example",
    platformUrl: "https://platform.example",
    syncPath: "/home/alice/matrixos",
    gatewayFolder: "",
    peerId: "peer",
    pauseSync: false,
  };
}

function baseSyncState() {
  return {
    manifestVersion: 0,
    lastSyncAt: 0,
    files: {},
  };
}
