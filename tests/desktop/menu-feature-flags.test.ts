import { describe, expect, it } from "vitest";
import { resolveCodingAgentsDesktopWorkspaceFlag } from "../../desktop/src/main/platform/menu-feature-flags";

describe("resolveCodingAgentsDesktopWorkspaceFlag", () => {
  it("keeps the Agents menu enabled by default", () => {
    expect(resolveCodingAgentsDesktopWorkspaceFlag(undefined)).toBe(true);
  });

  it("uses the bundled desktop workspace build flag when present", () => {
    expect(resolveCodingAgentsDesktopWorkspaceFlag(true)).toBe(true);
    expect(resolveCodingAgentsDesktopWorkspaceFlag(false)).toBe(false);
  });
});
