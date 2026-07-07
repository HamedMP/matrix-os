import { describe, expect, it } from "vitest";
import { palette } from "@matrix-os/brand";
import { matrixOnboardingPalette } from "../../shell/src/lib/onboarding-brand";

describe("onboarding-brand is unified with the canonical palette", () => {
  it("uses the canonical forest and ember", () => {
    expect(matrixOnboardingPalette.forest).toBe(palette.forest);
    expect(matrixOnboardingPalette.ember).toBe(palette.ember);
  });
});
