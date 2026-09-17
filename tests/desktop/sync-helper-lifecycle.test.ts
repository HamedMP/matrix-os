import { describe, expect, it, vi } from "vitest";
import { activateSyncHelperUpgrade } from "../../desktop/src/main/sync/sync-helper-lifecycle";

const previous = {
  schemaVersion: 1 as const,
  protocolVersion: 1 as const,
  cliVersion: "0.3.15",
  platform: "darwin" as const,
  arch: "arm64" as const,
  executable: "/stable/0.3.15/matrix",
  sha256: "a".repeat(64),
};
const installed = {
  ...previous,
  cliVersion: "0.3.16",
  executable: "/stable/0.3.16/matrix",
  sha256: "b".repeat(64),
  source: "packaged" as const,
  previous,
};

describe("sync helper upgrade lifecycle", () => {
  it("pauses the old service, activates the stable new helper and verifies readiness", async () => {
    let probes = 0;
    const run = vi.fn(async (_helper, args: string[]) => {
      if (args.includes("status")) {
        probes += 1;
        return { v: 1, ok: true, data: { running: probes >= 2 } };
      }
      return { ok: true };
    });
    const restore = vi.fn(async () => undefined);

    await expect(activateSyncHelperUpgrade(installed, {
      run,
      restore,
      wait: async () => undefined,
    })).resolves.toBeUndefined();

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: previous.executable }), [
      "sync", "pause", "--json", "--profile", "desktop",
    ]);
    expect(run).toHaveBeenCalledWith(installed, ["__desktop-activate"]);
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores and reactivates the previous helper when the new daemon never becomes ready", async () => {
    const run = vi.fn(async (_helper, args: string[]) => (
      args.includes("status")
        ? { v: 1, ok: true, data: { running: false } }
        : { ok: true }
    ));
    const restore = vi.fn(async () => undefined);

    await expect(activateSyncHelperUpgrade(installed, {
      run,
      restore,
      wait: async () => undefined,
      attempts: 2,
    })).rejects.toThrow("sync_helper_upgrade_failed");
    expect(restore).toHaveBeenCalledWith(previous);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: previous.executable,
    }), ["__desktop-activate"]);
  });
});
