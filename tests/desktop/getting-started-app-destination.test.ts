import { describe, expect, it } from "vitest";
import { DEFAULT_OS_VIEW_DESKTOP_APP_PATHS, osViewBundledIconUrlForPath } from "@matrix-os/contracts";
import { FIXED_DESKTOP_APPS, desktopAppsFor, desktopStartupCatalogSettled } from "@desktop/renderer/src/features/desktop-shell/desktop-apps";
import { normalizeBuiltInAppPath } from "../../shell/src/lib/builtin-apps";

describe("Getting started app destination (spec 639)", () => {
  it("is never a default desktop icon", () => {
    expect(DEFAULT_OS_VIEW_DESKTOP_APP_PATHS).not.toContain("__getting-started__");
    expect(FIXED_DESKTOP_APPS.map((app) => app.path)).not.toContain("__getting-started__");
  });

  it("joins Electron destinations only while the computer serves it", () => {
    expect(desktopAppsFor({ gettingStartedApp: false })).toBe(FIXED_DESKTOP_APPS);
    const enabled = desktopAppsFor({ gettingStartedApp: true });
    expect(enabled.at(-1)).toMatchObject({ id: "getting-started", path: "__getting-started__", kind: "getting-started", name: "Getting started" });
  });

  it("uses its bundled icon and canonical built-in path on Web", () => {
    expect(osViewBundledIconUrlForPath("__getting-started__")).toBe("/system-app-icons/v2/getting-started.png");
    expect(normalizeBuiltInAppPath("getting-started")).toBe("__getting-started__");
  });

  it("holds startup restore until it is known whether the computer serves Getting started", () => {
    // A saved Getting started window would otherwise be skipped when the check lands after restore.
    expect(desktopStartupCatalogSettled({ appsLoading: false, gettingStartedApp: "checking" })).toBe(false);
    expect(desktopStartupCatalogSettled({ appsLoading: false, gettingStartedApp: "enabled" })).toBe(true);
    expect(desktopStartupCatalogSettled({ appsLoading: false, gettingStartedApp: "unavailable" })).toBe(true);
    expect(desktopStartupCatalogSettled({ appsLoading: false, gettingStartedApp: null })).toBe(true);
    expect(desktopStartupCatalogSettled({ appsLoading: true, gettingStartedApp: "enabled" })).toBe(false);
  });
});
