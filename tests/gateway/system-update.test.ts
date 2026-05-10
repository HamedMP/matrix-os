import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForSystemUpdate,
  compareHostBundleVersions,
  isAutoApplyUpdate,
  parseUpdateChannel,
  startSystemUpdate,
} from "../../packages/gateway/src/system-update.js";

describe("system update checks", () => {
  it("compares host bundle releases by semver and commit", () => {
    expect(compareHostBundleVersions(
      { version: "v2026.05.06-2", gitCommit: "next" },
      { version: "v2026.05.06-1", gitCommit: "current" },
    )).toBe(true);
    expect(compareHostBundleVersions(
      { version: "v2026.05.06-1", gitCommit: "same" },
      { version: "v2026.05.06-1", gitCommit: "same" },
    )).toBe(false);
  });

  it("rejects unsupported update channels", () => {
    expect(parseUpdateChannel("stable")).toBe("stable");
    expect(parseUpdateChannel("canary")).toBe("canary");
    expect(parseUpdateChannel("../stable")).toBeNull();
    expect(parseUpdateChannel("nightly")).toBeNull();
  });

  it("fetches the configured channel manifest from the platform", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      kind: "matrix-os-host-bundle",
      version: "v2026.05.06-2",
      channel: "stable",
      gitCommit: "new-sha",
      gitRef: "refs/tags/v2026.05.06-2",
      buildTime: "2026-05-06T20:15:00.000Z",
      bundleSha256: "b".repeat(64),
      files: {
        bundle: {
          path: "system-bundles/v2026.05.06-2/matrix-host-bundle.tar.gz",
          sha256: "b".repeat(64),
          size: 123,
        },
      },
    })));

    const result = await checkForSystemUpdate({
      installed: {
        version: "v2026.05.06-1",
        gitCommit: "old-sha",
      },
      platformUrl: "https://app.matrix-os.com",
      channel: "stable",
      fetchImpl,
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.latest?.version).toBe("v2026.05.06-2");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.matrix-os.com/system-bundles/channels/stable.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("two-lane update severity", () => {
  it("auto-applies security updates", () => {
    expect(isAutoApplyUpdate({ severity: "security" })).toBe(true);
  });

  it("auto-applies when updateType is auto", () => {
    expect(isAutoApplyUpdate({ updateType: "auto" })).toBe(true);
  });

  it("does not auto-apply normal or critical updates without auto updateType", () => {
    expect(isAutoApplyUpdate({ severity: "normal" })).toBe(false);
    expect(isAutoApplyUpdate({ severity: "normal", updateType: "manual" })).toBe(false);
    expect(isAutoApplyUpdate({ severity: "critical" })).toBe(false);
  });

  it("auto-applies when updateType is auto even with normal severity", () => {
    expect(isAutoApplyUpdate({ severity: "normal", updateType: "auto" })).toBe(true);
  });

  it("does not auto-apply when fields are missing", () => {
    expect(isAutoApplyUpdate({})).toBe(false);
    expect(isAutoApplyUpdate({ severity: undefined })).toBe(false);
  });

  it("propagates severity and changelog through update check", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: "v2026.05.08-1",
      gitCommit: "sec-fix",
      severity: "security",
      changelog: "Critical auth bypass patched.",
      updateType: "auto",
    })));

    const result = await checkForSystemUpdate({
      installed: { version: "v2026.05.07-1", gitCommit: "old" },
      platformUrl: "https://app.matrix-os.com",
      channel: "stable",
      fetchImpl,
    });

    expect(result.latest?.severity).toBe("security");
    expect(result.latest?.changelog).toBe("Critical auth bypass patched.");
    expect(result.latest?.updateType).toBe("auto");
  });

  it("defaults missing severity to undefined (treated as normal by isAutoApplyUpdate)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: "v2026.05.08-1",
      gitCommit: "feature",
    })));

    const result = await checkForSystemUpdate({
      installed: { version: "v2026.05.07-1", gitCommit: "old" },
      platformUrl: "https://app.matrix-os.com",
      channel: "stable",
      fetchImpl,
    });

    expect(result.latest?.severity).toBeUndefined();
    expect(isAutoApplyUpdate({ severity: result.latest?.severity })).toBe(false);
  });
});

describe("system update start", () => {
  it("starts the local VPS updater through sudo with a validated channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-update-"));
    const updateCommand = join(dir, "matrix-update");
    writeFileSync(updateCommand, "#!/bin/sh\n", { mode: 0o755 });
    const spawnImpl = vi.fn().mockReturnValue({ unref: vi.fn() });

    try {
      const result = await startSystemUpdate({
        channel: "stable",
        updateCommand,
        spawnImpl,
      });

      expect(result).toEqual({ ok: true, status: "started" });
      expect(spawnImpl).toHaveBeenCalledWith(
        "sudo",
        ["-n", updateCommand, "stable"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error for unexpected updater access failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-update-"));
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await startSystemUpdate({
        channel: "stable",
        updateCommand: join(filePath, "matrix-update"),
      });

      expect(result).toEqual({ ok: false, status: "error" });
      expect(warn).toHaveBeenCalledWith(
        "[system-update] Failed to access update command:",
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
