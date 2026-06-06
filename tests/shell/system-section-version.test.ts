import { describe, expect, it } from "vitest";
import {
  compareHostBundleReleaseVersions,
  isNewer,
  normalizeMatrixReleaseTag,
  releaseActionLabel,
  resolveUpgradeInstallCopy,
  resolveSystemUpdateState,
  severityBadgeStyle,
  upgradeInstallStatusLine,
} from "../../shell/src/components/settings/sections/system-update-state.js";

describe("SystemSection version helpers", () => {
  it("ignores CLI releases when choosing Matrix OS app releases", () => {
    expect(normalizeMatrixReleaseTag("cli-v0.2.4")).toBeNull();
    expect(normalizeMatrixReleaseTag("v0.2.4")).toBe("0.2.4");
  });

  it("does not mark dev builds as older than semver releases", () => {
    expect(isNewer("0.2.4", "dev")).toBe(false);
  });

  it("compares app semver releases", () => {
    expect(isNewer("0.2.4", "0.2.3")).toBe(true);
    expect(isNewer("0.2.4", "0.2.4")).toBe(false);
    expect(isNewer("0.2.3", "0.2.4")).toBe(false);
  });

  it("compares host bundle releases for downgrade actions", () => {
    expect(compareHostBundleReleaseVersions("v2026.05.14-2", "v2026.05.14-1")).toBe(1);
    expect(compareHostBundleReleaseVersions("v2026.05.13-1", "v2026.05.14-1")).toBe(-1);
    expect(compareHostBundleReleaseVersions("v2026.05.14-1", "v2026.05.14-1")).toBe(0);
    expect(compareHostBundleReleaseVersions(
      "main-abc1234-20260514121530",
      "main-abc1234-20260514111530",
    )).toBe(1);
    expect(compareHostBundleReleaseVersions(
      "main-abc1234-20260513121530",
      "main-abc1234-20260514111530",
    )).toBe(-1);
    expect(compareHostBundleReleaseVersions(
      "main-abc1234-20260514121530",
      "v2026.05.14-1",
    )).toBe(1);
    expect(compareHostBundleReleaseVersions(
      "v2026.05.14-1",
      "main-abc1234-20260514121530",
    )).toBe(-1);
  });

  it("labels explicit release installs as upgrade or downgrade", () => {
    expect(releaseActionLabel({
      candidateVersion: "v2026.05.14-2",
      currentVersion: "v2026.05.14-1",
    })).toBe("Upgrade");
    expect(releaseActionLabel({
      candidateVersion: "v2026.05.13-1",
      currentVersion: "v2026.05.14-1",
    })).toBe("Downgrade");
    expect(releaseActionLabel({
      candidateVersion: "v2026.05.14-1",
      currentVersion: "v2026.05.14-1",
    })).toBe("Installed");
  });

  it("uses VPS host-bundle update metadata before GitHub release tags", () => {
    expect(resolveSystemUpdateState({
      installedVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.06-2",
      updateAvailable: true,
    })).toEqual({
      currentVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.06-2",
      updateAvailable: true,
      autoApplying: false,
      severity: undefined,
      changelog: undefined,
      showDot: true,
    });
  });

  it("marks security updates as auto-applying with no dot", () => {
    const state = resolveSystemUpdateState({
      installedVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.08-1",
      updateAvailable: true,
      severity: "security",
      changelog: "Critical auth bypass fix.",
    });
    expect(state.autoApplying).toBe(true);
    expect(state.showDot).toBe(false);
    expect(state.severity).toBe("security");
    expect(state.changelog).toBe("Critical auth bypass fix.");
  });

  it("shows dot for normal updates", () => {
    const state = resolveSystemUpdateState({
      installedVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.07-1",
      updateAvailable: true,
      severity: "normal",
    });
    expect(state.autoApplying).toBe(false);
    expect(state.showDot).toBe(true);
  });

  it("does not show dot when no update available", () => {
    const state = resolveSystemUpdateState({
      installedVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.06-1",
      updateAvailable: false,
    });
    expect(state.showDot).toBe(false);
  });

  it("marks updateType=auto as auto-applying even with normal severity", () => {
    const state = resolveSystemUpdateState({
      installedVersion: "v2026.05.06-1",
      latestVersion: "v2026.05.07-1",
      updateAvailable: true,
      severity: "normal",
      updateType: "auto",
    });
    expect(state.autoApplying).toBe(true);
    expect(state.showDot).toBe(false);
  });

  it("returns severity badge styles", () => {
    expect(severityBadgeStyle("security")).toContain("red");
    expect(severityBadgeStyle("critical")).toContain("orange");
    expect(severityBadgeStyle("normal")).toContain("blue");
    expect(severityBadgeStyle(undefined)).toContain("blue");
  });

  it("normalizes rotating upgrade install status lines", () => {
    expect(upgradeInstallStatusLine(0)).toBe("Reading the Matrix release notes between packets.");
    expect(upgradeInstallStatusLine(6)).toBe("Reading the Matrix release notes between packets.");
    expect(upgradeInstallStatusLine(-1)).toBe("Reading the Matrix release notes between packets.");
  });

  it("builds accessible upgrade install copy", () => {
    expect(resolveUpgradeInstallCopy({
      target: "dev",
      message: null,
      statusIndex: 1,
    })).toEqual({
      title: "Installing dev",
      detail: "Downloading the host bundle and waiting for the shell to return.",
      statusLine: "Cloud status: one host bundle, lightly compressed, coming right up.",
    });

    expect(resolveUpgradeInstallCopy({
      target: null,
      message: "Upgrade started. Waiting for services to come back...",
      statusIndex: 2,
    })).toEqual({
      title: "Installing update",
      detail: "Upgrade started. Waiting for services to come back...",
      statusLine: "A coding agent is watching the logs and resisting the urge to refactor them.",
    });
  });
});
