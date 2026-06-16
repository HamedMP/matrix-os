import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConfig } from "../../src/lib/config.js";

const {
  createSourceDaemonServiceCommandMock,
  createStandaloneDaemonServiceCommandMock,
  installServiceMock,
  isDaemonRunningMock,
  isStandaloneRuntimeMock,
  loadConfigMock,
  resolveCliProfileMock,
  saveConfigMock,
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
  loadConfigMock: vi.fn(),
  resolveCliProfileMock: vi.fn().mockResolvedValue({
    name: "cloud",
    platformUrl: "https://platform.example",
    gatewayUrl: "https://gateway.example",
  }),
  saveConfigMock: vi.fn().mockResolvedValue(undefined),
  sendCommandMock: vi.fn(),
  startServiceMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/config.js", () => ({
  defaultSyncPath: () => "/tmp/matrixos-sync-command-test",
  generatePeerId: () => "peer-generated",
  loadConfig: loadConfigMock,
  saveConfig: saveConfigMock,
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
  loadConfigMock.mockClear();
  loadConfigMock.mockResolvedValue(previousConfig());
  resolveCliProfileMock.mockClear();
  saveConfigMock.mockClear();
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
    expect(saveConfigMock).toHaveBeenCalledTimes(1);
    expect(saveConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "https://gateway.example",
        platformUrl: "https://platform.example",
        profile: "cloud",
        syncDaemonRuntime: "source",
      }),
    );
  });
});
