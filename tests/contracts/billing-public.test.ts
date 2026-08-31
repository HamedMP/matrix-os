import { describe, expect, it } from "vitest";

import { MatrixBillingStatusSchema } from "@matrix-os/contracts";

describe("public billing status contract", () => {
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
    ]) {
      expect(() => MatrixBillingStatusSchema.parse({
        entitlement: { ...common, ...leakedField },
        access: { runtimeProxyAllowed: true, reason: "active" },
        trialOffer: { eligible: false, durationDays: 3 },
      })).toThrow();
    }
  });
});
