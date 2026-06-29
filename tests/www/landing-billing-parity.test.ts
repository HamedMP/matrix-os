import { describe, expect, it } from "vitest";
import { MATRIX_BILLING_SERVER_PROFILES } from "@/lib/billing"; // @ -> shell/src
import {
  LANDING_PLANS,
  parsePlanUrlSlug,
  planSlugToFeatureSlug,
} from "../../www/src/lib/billing-plans";

describe("landing plan data parity with Stripe billing select", () => {
  it("matches every shell billing profile by planSlug", () => {
    for (const profile of MATRIX_BILLING_SERVER_PROFILES) {
      const plan = LANDING_PLANS.find((p) => p.planSlug === profile.planSlug);
      expect(plan, `missing landing plan for ${profile.planSlug}`).toBeTruthy();
      if (!plan) continue;
      expect(plan.label).toBe(profile.label);
      expect(plan.featureSlug).toBe(profile.featureSlug);
      expect(plan.machine).toBe(profile.hetznerType);
      expect(plan.vcpus).toBe(profile.vcpus);
      expect(plan.memoryGb).toBe(profile.memoryGb);
      expect(plan.diskGb).toBe(profile.diskGb);
      expect(plan.monthly).toBe(`$${profile.monthlyPriceUsd}`);
      expect(plan.annual).toBe(`$${profile.annualPriceUsd}`);
    }
  });

  it("covers exactly the shell profiles (no extra/stale landing plans)", () => {
    expect(LANDING_PLANS.length).toBe(MATRIX_BILLING_SERVER_PROFILES.length);
  });

  it("validates plan url slugs against the allowlist", () => {
    expect(parsePlanUrlSlug("builder")).toBe("matrix_builder");
    expect(parsePlanUrlSlug("BUILDER")).toBe("matrix_builder");
    expect(parsePlanUrlSlug("enterprise")).toBeNull();
    expect(parsePlanUrlSlug(undefined)).toBeNull();
    expect(parsePlanUrlSlug(null)).toBeNull();
  });

  it("maps plan slug to the shell feature slug", () => {
    expect(planSlugToFeatureSlug("matrix_builder")).toBe("server_cpx32");
    expect(planSlugToFeatureSlug("nope")).toBeNull();
  });
});
