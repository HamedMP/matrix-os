import { describe, expect, it, vi } from "vitest";
import {
  DaemonRequestSchema,
  formatDaemonError,
  formatDaemonSuccess,
  parseDaemonRequest,
} from "../../packages/sync-client/src/daemon/types.js";
import { createIpcHandler } from "../../packages/sync-client/src/daemon/ipc-handler.js";
import { createDaemonShellControlClient } from "../../packages/sync-client/src/daemon/shell-control-client.js";

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

  it("dispatches auth and workspace terminal commands through v1 dependencies", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    const tabId = "tt_00000000000000000000000000000001";
    const shell = {
      listWorkspaces: async () => [{ id: workspaceId, scope: "main" }],
      ensureWorkspace: async (input: Record<string, unknown>) => ({ ...input, id: workspaceId }),
      createTab: async (id: string, input: Record<string, unknown>) => ({ ...input, workspaceId: id, id: tabId }),
      terminateTab: async () => undefined,
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
    await expect(handler("terminal.workspaces.list", {})).resolves.toEqual({
      workspaces: [{ id: workspaceId, scope: "main" }],
    });
    await expect(handler("terminal.workspace.ensure", {})).resolves.toEqual({ id: workspaceId });
    await expect(handler("terminal.tab.create", { workspaceId, name: "main" })).resolves.toEqual({
      name: "main",
      workspaceId,
      id: tabId,
    });
    await expect(handler("terminal.tab.terminate", { workspaceId, tabId })).resolves.toEqual({ ok: true });
  });

  it("validates shell IPC payloads before dispatching to the REST client", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    const shell = {
      createTab: vi.fn(async (_id: string, input: Record<string, unknown>) => ({ ...input, created: true })),
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

    await expect(handler("terminal.tab.create", { workspaceId, name: "main", cwd: "../outside" })).rejects.toThrow("invalid_request");
    expect(shell.createTab).not.toHaveBeenCalled();
  });

  it("removes legacy session, native-pane, and layout commands while preserving sync aliases", async () => {
    const handler = createIpcHandler({
      config: baseConfig(),
      syncState: baseSyncState(),
      logger: { info: () => undefined },
      saveConfig: async () => undefined,
      persistPauseState: async () => undefined,
      clearAuth: async () => undefined,
      exit: () => undefined,
      shell: {},
    });

    for (const command of ["shell.list", "shell.create", "shell.destroy", "tab.list", "pane.split", "layout.list"]) {
      await expect(handler(command, {})).rejects.toThrow("Unknown IPC command");
    }
    await expect(handler("sync.status", {})).resolves.toMatchObject({ syncing: true, fileCount: 0 });
    await expect(handler("sync.pause", {})).resolves.toEqual({ paused: true });
    await expect(handler("sync.resume", {})).resolves.toEqual({ paused: false });
  });

  it("rejects invalid workspace and tab IDs before dispatch", async () => {
    const shell = {
      terminateTab: vi.fn(async () => undefined),
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

    await expect(handler("terminal.tab.terminate", { workspaceId: "main", tabId: "tab-1" })).rejects.toThrow("invalid_request");
    expect(shell.terminateTab).not.toHaveBeenCalled();
  });

  it("routes daemon shell-control through workspace and tab endpoints", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "workspace" })));
    vi.stubGlobal("fetch", fetchImpl);
    const client = createDaemonShellControlClient({
      config: baseConfig(),
      loadAuth: async () => ({
        accessToken: "tok",
        expiresAt: 4102444800000,
        userId: "user_1",
        handle: "neo",
      }),
    });

    try {
      await expect(client.createTab(workspaceId, { name: "tab" })).resolves.toEqual({ id: "workspace" });
      expect(fetchImpl).toHaveBeenCalledWith(
        `https://gateway.example/api/terminal/workspaces/${workspaceId}/tabs`,
        expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "tab" }) }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
