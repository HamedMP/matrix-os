import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkForSystemUpdate,
  compareHostBundleVersions,
  isAutoApplyUpdate,
  listSystemReleases,
  parseUpdateChannel,
  parseInternalUpgradeTarget,
  parseUpdateVersion,
  resolveSystemUpdateChannel,
  startSystemUpdate,
  writeInternalUpgradeTrigger,
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
    expect(parseUpdateChannel("beta")).toBe("beta");
    expect(parseUpdateChannel("dev")).toBe("dev");
    expect(parseUpdateChannel("../stable")).toBeNull();
    expect(parseUpdateChannel("nightly")).toBeNull();
  });

  it("resolves the update channel from request, environment, installed release, then stable", () => {
    expect(resolveSystemUpdateChannel("canary", { envChannel: "dev", installedChannel: "stable" })).toBe("canary");
    expect(resolveSystemUpdateChannel(undefined, { envChannel: "dev", installedChannel: "stable" })).toBe("dev");
    expect(resolveSystemUpdateChannel(undefined, { installedChannel: "beta" })).toBe("beta");
    expect(resolveSystemUpdateChannel(undefined, { installedChannel: "matrix-os-host-dev" })).toBe("stable");
    expect(resolveSystemUpdateChannel("nightly", { envChannel: "dev" })).toBeNull();
  });

  it("validates explicit update versions for internal deploy triggers", () => {
    expect(parseUpdateVersion("v2026.05.12-42")).toBe("v2026.05.12-42");
    expect(parseUpdateVersion(" v2026.05.12-42 ")).toBe("v2026.05.12-42");
    expect(parseUpdateVersion("main-969a192-20260512142352")).toBe("main-969a192-20260512142352");
    expect(parseUpdateVersion("../stable")).toBeNull();
    expect(parseUpdateVersion("stable")).toBeNull();
    expect(parseUpdateVersion("")).toBeNull();
  });

  it("parses internal deploy targets without allowing ambiguous requests", () => {
    expect(parseInternalUpgradeTarget({ version: "v2026.05.12-42" })).toEqual({
      ok: true,
      target: { type: "version", value: "v2026.05.12-42" },
    });
    expect(parseInternalUpgradeTarget({ channel: "beta" })).toEqual({
      ok: true,
      target: { type: "channel", value: "beta" },
    });
    expect(parseInternalUpgradeTarget({})).toEqual({ ok: true, target: null });
    expect(parseInternalUpgradeTarget({ version: "v2026.05.12-42", channel: "stable" })).toEqual({
      ok: false,
      error: "Specify either version or channel",
    });
    expect(parseInternalUpgradeTarget({ version: "../stable" })).toEqual({
      ok: false,
      error: "Invalid update version",
    });
    expect(parseInternalUpgradeTarget({ channel: "nightly" })).toEqual({
      ok: false,
      error: "Invalid update channel",
    });
  });

  it("writes requested versions before triggering an internal upgrade", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "matrix-upgrade-"));
    try {
      writeFileSync(join(appDir, ".update-channel"), "stable");
      const result = await writeInternalUpgradeTrigger({
        appDir,
        body: { version: "v2026.05.12-42" },
      });

      expect(result).toEqual({
        ok: true,
        target: { type: "version", value: "v2026.05.12-42" },
      });
      expect(readFileSync(join(appDir, ".update-version"), "utf8")).toBe("v2026.05.12-42");
      expect(existsSync(join(appDir, ".update-channel"))).toBe(false);
      expect(readFileSync(join(appDir, ".update-now"), "utf8")).toBe("");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it("writes requested channels before triggering an internal upgrade", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "matrix-upgrade-"));
    try {
      writeFileSync(join(appDir, ".update-version"), "v2026.05.12-41");
      const result = await writeInternalUpgradeTrigger({
        appDir,
        body: { channel: "canary" },
      });

      expect(result).toEqual({
        ok: true,
        target: { type: "channel", value: "canary" },
      });
      expect(readFileSync(join(appDir, ".update-channel"), "utf8")).toBe("canary");
      expect(existsSync(join(appDir, ".update-version"))).toBe(false);
      expect(readFileSync(join(appDir, ".update-now"), "utf8")).toBe("");
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
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

  it("lists releases for the selected channel from the platform", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      generatedAt: "2026-05-14T00:00:00.000Z",
      releases: [
        { version: "main-new", channel: "dev", gitCommit: "new-sha" },
        { version: "main-old", channel: "dev", gitCommit: "old-sha" },
      ],
    })));

    const result = await listSystemReleases({
      platformUrl: "https://app.matrix-os.com",
      channel: "dev",
      fetchImpl,
    });

    expect(result.releases.map((release) => release.version)).toEqual(["main-new", "main-old"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://app.matrix-os.com/system-bundles/releases?channel=dev",
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

  it("starts the local VPS updater with an explicit version for downgrades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-update-"));
    const updateCommand = join(dir, "matrix-update");
    writeFileSync(updateCommand, "#!/bin/sh\n", { mode: 0o755 });
    const spawnImpl = vi.fn().mockReturnValue({ unref: vi.fn() });

    try {
      const result = await startSystemUpdate({
        target: { type: "version", value: "v2026.05.12-1" },
        updateCommand,
        spawnImpl,
      });

      expect(result).toEqual({ ok: true, status: "started" });
      expect(spawnImpl).toHaveBeenCalledWith(
        "sudo",
        ["-n", updateCommand, "v2026.05.12-1"],
        expect.objectContaining({ detached: true, stdio: "ignore" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
