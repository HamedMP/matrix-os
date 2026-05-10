import { describe, expect, it } from "vitest";
import {
  isNewer,
  normalizeMatrixReleaseTag,
  resolveSystemUpdateState,
  severityBadgeStyle,
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
});
