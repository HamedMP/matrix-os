import { describe, expect, it } from "vitest";
import { OS_VIEW_PLACEABLE_BUILTIN_APPS, osViewFixedAppAppearanceForPath, osViewBundledIconUrlForPath } from "../../packages/contracts/src/os-view";

describe("Cloud desktop launcher contract", () => {
  it("has existing icon artwork", () => {
    expect(osViewFixedAppAppearanceForPath("__cloud-desktop__")?.icon).toBe("monitor");
    expect(osViewBundledIconUrlForPath("__cloud-desktop__")).toBe("/system-app-icons/v3/desktop.png");
  });

  it("is placeable without an installed owner HTML app", () => {
    expect(OS_VIEW_PLACEABLE_BUILTIN_APPS).toContainEqual({ appId: "cloud-desktop", name: "Cloud desktop", path: "__cloud-desktop__" });
  });
});
