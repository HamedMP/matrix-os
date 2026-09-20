import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConfig } from "../../src/lib/config.js";

const {
  createSourceDaemonServiceCommandMock,
  createStandaloneDaemonServiceCommandMock,
  installServiceMock,
  isDaemonRunningMock,
  isStandaloneRuntimeMock,
  loadProfileSyncConfigMock,
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
  loadProfileSyncConfigMock: vi.fn(),
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
}));

vi.mock("../../src/lib/profile-sync-config.js", () => ({
  loadProfileSyncConfig: loadProfileSyncConfigMock,
  saveProfileSyncConfig: saveProfileSyncConfigMock,
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
  loadProfileSyncConfigMock.mockClear();
  loadProfileSyncConfigMock.mockResolvedValue({ config: previousConfig() });
  resolveCliProfileMock.mockClear();
  saveProfileSyncConfigMock.mockClear();
  sendCommandMock.mockClear();
  sendCommandMock.mockResolvedValue(previousConfig({ profile: "cloud", gatewayUrl: "https://gateway.example", platformUrl: "https://platform.example" }));
  startServiceMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncCommand start", () => {
  it("repairs the service when the live configuration probe fails", async () => {
    sendCommandMock.mockRejectedValueOnce(new Error("IPC unavailable"));
    await runSync();
    expect(installServiceMock).toHaveBeenCalledOnce();
    expect(startServiceMock).toHaveBeenCalledOnce();
  });
  it("restarts when the live daemon belongs to another profile despite a matching saved target", async () => {
    loadProfileSyncConfigMock.mockResolvedValue({ config: previousConfig({ profile: "cloud" }) });
    sendCommandMock.mockResolvedValue(previousConfig({ profile: "local" }));
    await runSync();
    expect(installServiceMock).toHaveBeenCalledOnce();
    expect(startServiceMock).toHaveBeenCalledOnce();
  });

  it("renders idle sync separately from a paused daemon", async () => {
    sendCommandMock.mockResolvedValue({ syncing: false, paused: false, status: "synced", manifestVersion: 2, fileCount: 3 });
    await runSync({}, ["status"]);
    expect(console.log).toHaveBeenCalledWith("  Status: synced");
    expect(console.log).not.toHaveBeenCalledWith("  Syncing: paused");
  });
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
