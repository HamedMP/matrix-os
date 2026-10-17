import { describe, expect, it } from "vitest";
import { osViewFixedAppAppearanceForPath, osViewBundledIconUrlForPath } from "../../packages/contracts/src/os-view";

describe("Cloud desktop launcher contract", () => {
  it("has existing icon artwork", () => {
    expect(osViewFixedAppAppearanceForPath("__cloud-desktop__")?.icon).toBe("monitor");
    expect(osViewBundledIconUrlForPath("__cloud-desktop__")).toBe("/system-app-icons/v3/desktop.png");
  });
});
