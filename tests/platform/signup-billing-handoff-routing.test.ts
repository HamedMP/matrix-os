import { describe, expect, it } from "vitest";
import {
  getPlatformShellAssetUpstreamPath,
  isSignupBillingHandoff,
} from "../../packages/platform/src/request-routing.js";

describe("platform signup billing handoff routing", () => {
  it("recognizes only the exact bounded marker", () => {
    expect(isSignupBillingHandoff("/?billing=setup&handoff=signup")).toBe(true);
    expect(isSignupBillingHandoff("/?handoff=signup&billing=setup")).toBe(true);
    expect(
      isSignupBillingHandoff(
        "/?billing=setup&handoff=signup&selectedPlan=matrix_builder",
      ),
    ).toBe(true);

    expect(isSignupBillingHandoff("/?billing=setup&handoff=signup-extra")).toBe(false);
    expect(
      isSignupBillingHandoff("/?billing=setup&handoff=signup&handoff=signup"),
    ).toBe(false);
    expect(isSignupBillingHandoff("/?billing=other&handoff=signup")).toBe(false);
    expect(
      isSignupBillingHandoff("/sign-in?billing=setup&handoff=signup"),
    ).toBe(false);
    expect(
      isSignupBillingHandoff(
        `/?billing=setup&handoff=signup&padding=${"x".repeat(4_100)}`,
      ),
    ).toBe(false);
  });

  it("allows only official auth assets through the platform namespace", () => {
    for (const assetPath of [
      "/rabbit.svg",
      "/agents/claude-code.svg",
      "/agents/codex.svg",
      "/agents/cursor.svg",
    ]) {
      expect(
        getPlatformShellAssetUpstreamPath(`/__platform-shell${assetPath}`),
      ).toBe(assetPath);
    }
    expect(
      getPlatformShellAssetUpstreamPath("/__platform-shell/agents/arbitrary.svg"),
    ).toBeNull();
  });
});
