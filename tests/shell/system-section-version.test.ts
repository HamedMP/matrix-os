import { describe, expect, it } from "vitest";
import {
  compareHostBundleReleaseVersions,
  isNewer,
  normalizeMatrixReleaseTag,
  releaseActionLabel,
  resolveUpgradeInstallCopy,
  resolveUpdateFailureNotice,
  resolveSystemUpdateState,
  severityBadgeStyle,
  formatReleaseBuildId,
  formatReleaseBuildShortId,
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

  it("formats release build IDs without exposing full commit hashes by default", () => {
    expect(formatReleaseBuildId("0f7e2f12554e1941d10c29b2209e0a6c2d7e2438")).toBe("Build ID 0f7e2f12554e");
    expect(formatReleaseBuildId(undefined)).toBeNull();
  });

  it("formats short build ID values for labeled fields", () => {
    expect(formatReleaseBuildShortId("0f7e2f12554e1941d10c29b2209e0a6c2d7e2438")).toBe("0f7e2f12554e");
    expect(formatReleaseBuildShortId(undefined)).toBeNull();
  });

  it("normalizes rotating upgrade install status lines", () => {
    expect(upgradeInstallStatusLine(0)).toBe("Putting the new version in place. Your files stay where they are.");
    expect(upgradeInstallStatusLine(6)).toBe("Putting the new version in place. Your files stay where they are.");
    expect(upgradeInstallStatusLine(-1)).toBe("Putting the new version in place. Your files stay where they are.");
  });

  it("builds accessible upgrade install copy", () => {
    expect(resolveUpgradeInstallCopy({
      target: "dev",
      message: null,
      statusIndex: 1,
    })).toEqual({
      title: "Installing dev",
      detail: "Downloading the update and waiting for your workspace to return.",
      statusLine: "Almost there. We are making sure everything opens cleanly.",
    });

    expect(resolveUpgradeInstallCopy({
      target: null,
      message: "Upgrade started. Waiting for services to come back...",
      statusIndex: 2,
    })).toEqual({
      title: "Installing update",
      detail: "Upgrade started. Waiting for services to come back...",
      statusLine: "Your workspace is getting the new version ready.",
    });
  });

  it("builds actionable low-disk update failure copy", () => {
    expect(resolveUpdateFailureNotice({
      code: "insufficient_disk_space",
      message: "Not enough free disk space to install this update.",
      availableKb: 3584640,
      requiredKb: 8232960,
      repairAvailable: true,
    })).toEqual({
      tone: "warning",
      title: "Not enough disk space",
      detail: "Free about 4.4 GB before retrying the update.",
      actionLabel: "Clean Up and Retry",
    });
  });

  it("uses generic update failure copy for unknown failure markers", () => {
    expect(resolveUpdateFailureNotice({
      code: "unknown",
      message: "Update failed.",
      repairAvailable: false,
    })).toEqual({
      tone: "error",
      title: "Update failed",
      detail: "Update failed.",
      actionLabel: null,
    });
  });
});
