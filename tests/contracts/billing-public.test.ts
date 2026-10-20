import { describe, expect, it } from "vitest";

import { MatrixBillingStatusSchema, getMatrixBillingTrialDurationDays } from "@matrix-os/contracts";

describe("public billing status contract", () => {
  it("accepts only a bounded provider-neutral active checkout selection", () => {
    const result = MatrixBillingStatusSchema.parse({
      entitlement: null,
      access: { runtimeProxyAllowed: false, reason: "no_entitlement" },
      trialOffer: { eligible: true, durationDays: 3 },
      activeCheckout: {
        status: "open",
        planSlug: "matrix_starter",
        interval: "monthly",
        regionSlug: "region_nbg1",
        developerTools: ["codex"],
      },
    });

    expect(result.activeCheckout).toEqual({
      status: "open",
      planSlug: "matrix_starter",
      interval: "monthly",
      regionSlug: "region_nbg1",
      developerTools: ["codex"],
    });
    expect(() => MatrixBillingStatusSchema.parse({
      ...result,
      activeCheckout: { ...result.activeCheckout, stripeSessionId: "cs_secret" },
    })).toThrow();
  });

  it("accepts provider-neutral entitlement metadata", () => {
    const result = MatrixBillingStatusSchema.parse({
      entitlement: {
        source: "stripe",
        planSlug: "matrix_builder",
        status: "active",
        maxRuntimeSlots: 1,
        includedRuntimeSlots: 1,
        addonRuntimeSlots: 0,
        allowedPlanSlugs: ["matrix_starter", "matrix_builder"],
        allowedSelections: [
          { planSlug: "matrix_starter", regionSlug: "region_fsn1" },
          { planSlug: "matrix_builder", regionSlug: "region_ash" },
        ],
        portalAvailable: true,
        billingInterval: "monthly",
        recurringPrice: {
          unitAmountMinor: 2000,
          currency: "usd",
          interval: "monthly",
          intervalCount: 1,
          quantity: 1,
        },
        runtimePlacement: {
          regionSlug: "region_ash",
          label: "Ashburn, Virginia",
          countryLabel: "United States",
          networkZone: "us-east",
        },
        gracePeriodEndsAt: null,
        trialStartedAt: null,
        trialEndsAt: null,
        trialConvertedAt: null,
        firstTrialPaymentFailedAt: null,
        effectiveFrom: "2026-08-31T00:00:00.000Z",
        effectiveUntil: null,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      access: { runtimeProxyAllowed: true, reason: "active" },
      trialOffer: { eligible: false, durationDays: 3 },
    });

    expect(result.entitlement?.allowedPlanSlugs).toEqual([
      "matrix_starter",
      "matrix_builder",
    ]);
    expect(result.entitlement?.allowedSelections).toEqual([
      { planSlug: "matrix_starter", regionSlug: "region_fsn1" },
      { planSlug: "matrix_builder", regionSlug: "region_ash" },
    ]);
    expect(result.entitlement?.recurringPrice?.unitAmountMinor).toBe(2000);
    expect(result.entitlement?.runtimePlacement?.label).toBe("Ashburn, Virginia");
  });

  it("validates bounded plan-specific trial offers without breaking legacy offers", () => {
    const base = { entitlement: null, access: { runtimeProxyAllowed: false, reason: "no_entitlement" } };
    expect(MatrixBillingStatusSchema.parse({ ...base, trialOffer: {
      eligible: true, durationDays: 7, eligiblePlanSlugs: ["matrix_starter"],
    } }).trialOffer.eligiblePlanSlugs).toEqual(["matrix_starter"]);
    expect(MatrixBillingStatusSchema.parse({ ...base, trialOffer: {
      eligible: true, durationDays: 3,
    } }).trialOffer.eligiblePlanSlugs).toBeUndefined();
    for (const eligiblePlanSlugs of [["unknown"], Array(4).fill("matrix_starter"), "matrix_starter"]) {
      expect(MatrixBillingStatusSchema.safeParse({ ...base, trialOffer: {
        eligible: true, durationDays: 7, eligiblePlanSlugs,
      } }).success).toBe(false);
    }
  });

  it("resolves selected-plan eligibility including reserved legacy offers", () => {
    const starterOffer = { eligible: true, durationDays: 7, eligiblePlanSlugs: ["matrix_starter"] as const };
    expect(getMatrixBillingTrialDurationDays(starterOffer, "matrix_starter")).toBe(7);
    expect(getMatrixBillingTrialDurationDays(starterOffer, "matrix_builder")).toBeNull();
    expect(getMatrixBillingTrialDurationDays({ eligible: true, durationDays: 3 }, "matrix_builder")).toBe(3);
    expect(getMatrixBillingTrialDurationDays({ eligible: true, durationDays: 3, eligiblePlanSlugs: ["matrix_builder"] }, "matrix_builder")).toBe(3);
    expect(getMatrixBillingTrialDurationDays({ ...starterOffer, eligible: false }, "matrix_starter")).toBeNull();
    expect(getMatrixBillingTrialDurationDays({ ...starterOffer, eligiblePlanSlugs: [] }, "matrix_starter")).toBeNull();
    expect(getMatrixBillingTrialDurationDays(null, "matrix_starter")).toBeNull();
  });

  it("projects each selected plan's trial duration and fails closed on a missing mapped plan", () => {
    const offer = { eligible: true, durationDays: 3, eligiblePlanSlugs: ["matrix_starter", "matrix_builder", "matrix_max"] as const,
      durationDaysByPlan: { matrix_starter: 14, matrix_builder: 3, matrix_max: 3 } };
    const parsed = MatrixBillingStatusSchema.parse({ entitlement: null,
      access: { runtimeProxyAllowed: false, reason: "no_entitlement" }, trialOffer: offer });
    expect(parsed.trialOffer.durationDaysByPlan).toEqual(offer.durationDaysByPlan);
    expect(getMatrixBillingTrialDurationDays(offer, "matrix_starter")).toBe(14);
    expect(getMatrixBillingTrialDurationDays(offer, "matrix_builder")).toBe(3);
    expect(getMatrixBillingTrialDurationDays(offer, "matrix_max")).toBe(3);
    expect(getMatrixBillingTrialDurationDays({ ...offer, durationDaysByPlan: { matrix_starter: 14 } }, "matrix_builder")).toBeNull();
    for (const durationDaysByPlan of [{ matrix_starter: 31 }, { private_plan: 7 }, { matrix_builder: 0 }]) {
      expect(MatrixBillingStatusSchema.safeParse({ entitlement: null,
        access: { runtimeProxyAllowed: false, reason: "no_entitlement" },
        trialOffer: { ...offer, durationDaysByPlan } }).success).toBe(false);
    }
  });

  it("rejects provider and payment-processor identifiers", () => {
    const common = {
      source: "stripe",
      planSlug: "matrix_builder",
      status: "active",
      maxRuntimeSlots: 1,
      includedRuntimeSlots: 1,
      addonRuntimeSlots: 0,
      allowedPlanSlugs: ["matrix_builder"],
      allowedSelections: [{ planSlug: "matrix_builder", regionSlug: "region_ash" }],
      portalAvailable: true,
      recurringPrice: null,
      runtimePlacement: null,
      gracePeriodEndsAt: null,
      effectiveFrom: "2026-08-31T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };

    for (const leakedField of [
      { clerkUserId: "user_secret" },
      { defaultServerType: "cpx31" },
      { allowedServerTypes: ["cpx31"] },
      { stripeSubscriptionId: "sub_secret" },
      { stripePriceId: "price_secret" },
      { serverType: "cpx31" },
      { provider: "hetzner" },
    ]) {
      expect(() => MatrixBillingStatusSchema.parse({
        entitlement: { ...common, ...leakedField },
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 3 },
      })).toThrow();
    }
  });
});
