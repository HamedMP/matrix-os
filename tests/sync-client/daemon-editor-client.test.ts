import { describe, expect, it } from "vitest";
import { createIpcHandler } from "../../packages/sync-client/src/daemon/ipc-handler.js";

describe("daemon editor-client contract fixture", () => {
  it("uses only v1 commands for auth and workspace/tab discovery", async () => {
    const workspaceId = "tws_00000000000000000000000000000001";
    const tabId = "tt_00000000000000000000000000000001";
    const handler = createIpcHandler({
      config: {
        gatewayUrl: "https://gateway.example",
        platformUrl: "https://platform.example",
        syncPath: "/home/alice/matrixos",
        gatewayFolder: "",
        peerId: "peer",
        pauseSync: false,
      },
      syncState: { manifestVersion: 0, lastSyncAt: 0, files: {} },
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
      shell: {
        listWorkspaces: async () => [{ id: workspaceId, scope: "main", tabs: [] }],
        ensureWorkspace: async () => ({ id: workspaceId, scope: "main", tabs: [] }),
        createTab: async () => ({ id: tabId, workspaceId, displayName: "main" }),
      },
    });

    await expect(handler("auth.whoami", {})).resolves.toMatchObject({
      authenticated: true,
      handle: "neo",
    });
    await expect(handler("auth.token", {})).resolves.toMatchObject({
      accessToken: "tok",
    });
    await expect(handler("terminal.workspaces.list", {})).resolves.toEqual({
      workspaces: [{ id: workspaceId, scope: "main", tabs: [] }],
    });
    await expect(handler("terminal.workspace.ensure", {})).resolves.toMatchObject({ id: workspaceId });
    await expect(handler("terminal.tab.create", { workspaceId, name: "main" })).resolves.toEqual({
      id: tabId,
      workspaceId,
      displayName: "main",
    });
    await expect(handler("status", {})).resolves.toMatchObject({
      gatewayUrl: "https://gateway.example",
    });
  });
});
