import { onboardingChecklist } from "@matrix-os/brand/tokens";
import { describe, expect, it } from "vitest";
import { getVpsBootPage } from "../../packages/platform/src/auth-pages.js";

describe("VPS boot page brand contract", () => {
  it("uses the shared onboarding progress tokens", () => {
    const html = getVpsBootPage({ status: "provisioning" });

    expect(html).toContain(`background: ${onboardingChecklist.colors.progressTrack}`);
    expect(html).toContain(`background: ${onboardingChecklist.colors.progressFill}`);
  });
});
