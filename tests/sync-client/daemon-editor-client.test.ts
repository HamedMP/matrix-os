import { describe, expect, it } from "vitest";
import { createIpcHandler } from "../../packages/sync-client/src/daemon/ipc-handler.js";

describe("daemon editor-client contract fixture", () => {
  it("uses only v1 commands for auth, session list/create, and attach URL discovery", async () => {
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
        listSessions: async () => [],
        createSession: async () => ({ name: "main", created: true }),
      },
    });

    await expect(handler("auth.whoami", {})).resolves.toMatchObject({
      authenticated: true,
      handle: "neo",
    });
    await expect(handler("auth.token", {})).resolves.toMatchObject({
      accessToken: "tok",
    });
    await expect(handler("shell.list", {})).resolves.toEqual({ sessions: [] });
    await expect(handler("shell.create", { name: "main" })).resolves.toEqual({
      name: "main",
      created: true,
    });
    await expect(handler("status", {})).resolves.toMatchObject({
      gatewayUrl: "https://gateway.example",
    });
  });
});
