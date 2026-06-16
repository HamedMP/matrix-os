import { describe, expect, it } from "vitest";
import { shouldReuseRunningSyncService } from "../../src/cli/commands/sync.js";
import type { SyncConfig } from "../../src/lib/config.js";

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    gatewayUrl: "https://app.matrix-os.com",
    syncPath: "/home/user/matrixos",
    gatewayFolder: "",
    peerId: "peer-1",
    pauseSync: false,
    ...overrides,
  };
}

describe("shouldReuseRunningSyncService", () => {
  it("does not reuse a running source service when the standalone CLI should own the daemon", () => {
    expect(
      shouldReuseRunningSyncService({
        previous: config({ syncDaemonRuntime: "source" }),
        syncPath: "/home/user/matrixos",
        gatewayFolder: "",
        currentRuntime: "standalone",
      }),
    ).toBe(false);
  });

  it("reuses an already-running standalone service for the same sync target", () => {
    expect(
      shouldReuseRunningSyncService({
        previous: config({ syncDaemonRuntime: "standalone" }),
        syncPath: "/home/user/matrixos",
        gatewayFolder: "",
        currentRuntime: "standalone",
      }),
    ).toBe(true);
  });

  it("keeps legacy source configs compatible when runtime metadata is absent", () => {
    expect(
      shouldReuseRunningSyncService({
        previous: config(),
        syncPath: "/home/user/matrixos",
        gatewayFolder: "",
        currentRuntime: "source",
      }),
    ).toBe(true);
  });
});
