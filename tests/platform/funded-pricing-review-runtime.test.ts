import { describe, expect, it } from "vitest";
import { fundedPricingReviewRuntimeConfig } from "../../packages/platform/src/funded-pricing-review-runtime.js";

const enabled = {
  MATRIX_FUNDED_AI_PRICING_REVIEW_JOB_ENABLED: "true",
  MATRIX_FUNDED_AI_PRICING_LINEAR_API_KEY: "lin_api_example",
  MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID: "11111111-1111-4111-8111-111111111111",
  MATRIX_FUNDED_AI_PRICING_LINEAR_OPEN_STATE_ID: "22222222-2222-4222-8222-222222222222",
  MATRIX_FUNDED_AI_PRICING_LINEAR_COMPLETED_STATE_ID: "33333333-3333-4333-8333-333333333333",
};

describe("funded pricing review runtime configuration", () => {
  it("uses the dedicated Cloud Run worker for review and a separate public process for watchdog", () => {
    const env = { ...enabled, PLATFORM_RUNTIME_MODE: "cloud_run" };
    expect(fundedPricingReviewRuntimeConfig(env, true, true)?.mode).toBe("review");
    expect(fundedPricingReviewRuntimeConfig(env, true, false)?.mode).toBe("watchdog");
    expect(fundedPricingReviewRuntimeConfig(enabled, true, true)?.mode).toBe("both");
  });

  it("fails early for enabled but incomplete configuration and leaves old deployments inactive", () => {
    expect(fundedPricingReviewRuntimeConfig({}, true, false)).toBeUndefined();
    expect(() => fundedPricingReviewRuntimeConfig({ ...enabled, MATRIX_FUNDED_AI_PRICING_LINEAR_TEAM_ID: "wrong" }, true, true))
      .toThrow("Funded pricing review job configuration is incomplete");
    expect(() => fundedPricingReviewRuntimeConfig(enabled, false, true)).toThrow("requires Funded AI");
  });
});
