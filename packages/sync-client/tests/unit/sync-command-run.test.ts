import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConfig } from "../../src/lib/config.js";

const {
  createSourceDaemonServiceCommandMock,
  createStandaloneDaemonServiceCommandMock,
  installServiceMock,
  isDaemonRunningMock,
  isStandaloneRuntimeMock,
  loadProfileAuthMock,
  loadProfileSyncConfigMock,
  loadSyncMappingConfigMock,
  resolveCliProfileMock,
  saveProfileSyncConfigMock,
  sendCommandMock,
  startServiceMock,
} = vi.hoisted(() => ({
  createSourceDaemonServiceCommandMock: vi.fn(() => ({
    executable: "/usr/bin/node",
    args: ["/repo/launcher.mjs"],
    workingDirectory: "/repo",
  })),
  createStandaloneDaemonServiceCommandMock: vi.fn(() => ({
    executable: "/home/user/.local/bin/matrix",
    args: ["__daemon"],
    workingDirectory: "/home/user",
  })),
  installServiceMock: vi.fn().mockResolvedValue("/service/path"),
  isDaemonRunningMock: vi.fn().mockResolvedValue(true),
  isStandaloneRuntimeMock: vi.fn(() => false),
  loadProfileAuthMock: vi.fn(),
  loadProfileSyncConfigMock: vi.fn(),
  loadSyncMappingConfigMock: vi.fn(),
  resolveCliProfileMock: vi.fn().mockResolvedValue({
    name: "cloud",
    platformUrl: "https://platform.example",
    gatewayUrl: "https://gateway.example",
  }),
  saveProfileSyncConfigMock: vi.fn().mockResolvedValue(undefined),
  sendCommandMock: vi.fn(),
  startServiceMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/config.js", () => ({
  defaultSyncPath: () => "/tmp/matrixos-sync-command-test",
  generatePeerId: () => "peer-generated",
  getConfigDir: () => "/tmp/.matrixos",
}));

vi.mock("../../src/lib/profile-sync-config.js", () => ({
  loadProfileSyncConfig: loadProfileSyncConfigMock,
  saveProfileSyncConfig: saveProfileSyncConfigMock,
}));

vi.mock("../../src/auth/token-store.js", () => ({
  loadProfileAuth: loadProfileAuthMock,
}));

vi.mock("../../src/lib/sync-mapping-config.js", () => ({
  loadSyncMappingConfig: loadSyncMappingConfigMock,
}));

vi.mock("../../src/cli/daemon-client.js", () => ({
  isDaemonClientError: () => false,
  isDaemonRunning: isDaemonRunningMock,
  sendCommand: sendCommandMock,
}));

vi.mock("../../src/daemon/service.js", () => ({
  createSourceDaemonServiceCommand: createSourceDaemonServiceCommandMock,
  createStandaloneDaemonServiceCommand: createStandaloneDaemonServiceCommandMock,
  installService: installServiceMock,
  startService: startServiceMock,
}));

vi.mock("../../src/cli/profiles.js", () => ({
  resolveCliProfile: resolveCliProfileMock,
}));

vi.mock("../../src/cli/standalone-runtime.js", () => ({
  isStandaloneRuntime: isStandaloneRuntimeMock,
}));

function previousConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    gatewayUrl: "https://old-gateway.example",
    syncPath: "/tmp/matrixos-sync-command-test",
    gatewayFolder: "",
    peerId: "peer-1",
    pauseSync: false,
    platformUrl: "https://old-platform.example",
    profile: "old",
    syncDaemonRuntime: "source",
    ...overrides,
  };
}

async function runSync(args: Record<string, unknown> = {}, rawArgs: string[] = []): Promise<void> {
  const mod = await import("../../src/cli/commands/sync.js");
  await mod.syncCommand.run!({ args: { json: false, ...args }, rawArgs } as never);
}

beforeEach(() => {
  vi.resetModules();
  createSourceDaemonServiceCommandMock.mockClear();
  createStandaloneDaemonServiceCommandMock.mockClear();
  installServiceMock.mockClear();
  isDaemonRunningMock.mockClear();
  isDaemonRunningMock.mockResolvedValue(true);
  isStandaloneRuntimeMock.mockClear();
  isStandaloneRuntimeMock.mockReturnValue(false);
  loadProfileAuthMock.mockClear();
  loadProfileAuthMock.mockResolvedValue({
    accessToken: "stored-token",
    expiresAt: Date.now() - 1,
    userId: "user_test",
    handle: "test",
    runtimeSlot: "primary",
  });
  loadProfileSyncConfigMock.mockClear();
  loadProfileSyncConfigMock.mockResolvedValue({ config: previousConfig() });
  resolveCliProfileMock.mockClear();
  loadSyncMappingConfigMock.mockClear();
  saveProfileSyncConfigMock.mockClear();
  sendCommandMock.mockClear();
  startServiceMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncCommand start", () => {
  it("persists refreshed config before returning when the correct daemon is already running", async () => {
    await runSync();

    expect(installServiceMock).not.toHaveBeenCalled();
    expect(startServiceMock).not.toHaveBeenCalled();
    expect(saveProfileSyncConfigMock).toHaveBeenCalledTimes(1);
    expect(saveProfileSyncConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "https://gateway.example",
        platformUrl: "https://platform.example",
        profile: "cloud",
        syncDaemonRuntime: "source",
      }),
    );
  });
});

describe("syncCommand mapping subcommands", () => {
  const mappingId = "11111111-1111-4111-8111-111111111111";
  const config = {
    schemaVersion: 2,
    revision: 7,
    profile: "cloud",
    ownerId: "user_test",
    runtimeSlot: "primary",
    deviceId: "peer-1",
    enabled: true,
    mappings: [{
      id: mappingId,
      label: "Matrix Home",
      localRoot: "/tmp/matrixos-sync-command-test",
      remotePrefix: "",
      direction: "two_way",
      enabled: true,
      propagateDeletes: false,
      excludes: [],
    }],
  };

  it("lists the daemon-owned versioned mapping config", async () => {
    sendCommandMock.mockResolvedValueOnce({ config });

    await runSync({ json: true }, ["list"]);

    expect(sendCommandMock).toHaveBeenCalledWith("sync.mappings.list");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"revision":7'));
  });

  it("lists the stored mapping config when the daemon is stopped", async () => {
    isDaemonRunningMock.mockResolvedValueOnce(false);
    resolveCliProfileMock.mockResolvedValueOnce({
      name: "desktop",
      platformUrl: "https://platform.example",
      gatewayUrl: "https://gateway.example",
    });
    loadSyncMappingConfigMock.mockResolvedValueOnce({ ...config, profile: "desktop" });

    await runSync({ json: true, profile: "desktop" }, ["list"]);

    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(loadProfileAuthMock).toHaveBeenCalledWith("desktop");
    expect(loadSyncMappingConfigMock).toHaveBeenCalledWith({
      configDir: expect.stringContaining(".matrixos"),
      profile: "desktop",
      scope: { ownerId: "user_test", runtimeSlot: "primary" },
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"profile":"desktop"'));
  });

  it("adds a mapping with the current expected revision and safe deletion default", async () => {
    sendCommandMock
      .mockResolvedValueOnce({ config })
      .mockResolvedValueOnce({ config: { ...config, revision: 8 } });

    await runSync({
      path: "/tmp/matrixos-sync-command-test/project",
      folder: "projects/project",
      direction: "to_matrix",
      label: "Project",
      exclude: "node_modules/,dist/",
      excludeParent: mappingId,
    }, ["add"]);

    expect(sendCommandMock).toHaveBeenNthCalledWith(1, "sync.mappings.list");
    expect(sendCommandMock).toHaveBeenNthCalledWith(2, "sync.mappings.add", {
      expectedRevision: 7,
      mapping: expect.objectContaining({
        label: "Project",
        remotePrefix: "projects/project",
        direction: "to_matrix",
        propagateDeletes: false,
        excludes: ["node_modules/", "dist/"],
      }),
      parentMappingId: mappingId,
    });
  });

  it.each(["pause", "resume", "remove"] as const)(
    "%s uses a mapping id and optimistic revision",
    async (command) => {
      sendCommandMock
        .mockResolvedValueOnce({ config })
        .mockResolvedValueOnce({ config: { ...config, revision: 8 } });

      await runSync({ mapping: mappingId }, [command]);

      expect(sendCommandMock).toHaveBeenNthCalledWith(2, `sync.mappings.${command}`, {
        expectedRevision: 7,
        mappingId,
      });
    },
  );

  it("keeps pause without --mapping backward compatible", async () => {
    sendCommandMock.mockResolvedValueOnce({ paused: true });

    await runSync({}, ["pause"]);

    expect(sendCommandMock).toHaveBeenCalledWith("pause");
  });

  it.each(["conflicts", "rescan"])("routes %s through mapping IPC", async (command) => {
    sendCommandMock.mockResolvedValueOnce(command === "conflicts"
      ? { conflicts: [] }
      : { accepted: true });

    await runSync({ mapping: mappingId }, [command]);

    expect(sendCommandMock).toHaveBeenCalledWith(`sync.mappings.${command}`, {
      mappingId,
    });
  });
});
