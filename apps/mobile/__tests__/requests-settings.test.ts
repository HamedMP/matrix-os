jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

import { fetchMobileBillingStatus } from "@/lib/requests/settings";

const overrideBillingStatus = {
  activeCheckout: null,
  entitlement: {
    source: "override",
    planSlug: "matrix_builder",
    status: "active",
    maxRuntimeSlots: 1,
    includedRuntimeSlots: 1,
    addonRuntimeSlots: 0,
    allowedPlanSlugs: ["matrix_builder"],
    allowedSelections: [],
    portalAvailable: true,
    billingInterval: null,
    recurringPrice: null,
    runtimePlacement: null,
    gracePeriodEndsAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    trialConvertedAt: null,
    firstTrialPaymentFailedAt: null,
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  access: {
    runtimeProxyAllowed: true,
    reason: "active",
  },
  trialOffer: {
    eligible: false,
    durationDays: 3,
  },
};

describe("settings requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("accepts plan-specific trial durations from the shared public contract", async () => {
    const status = {
      entitlement: null,
      access: { runtimeProxyAllowed: false, reason: "no_entitlement" },
      trialOffer: {
        eligible: true,
        durationDays: 3,
        eligiblePlanSlugs: ["matrix_starter", "matrix_builder", "matrix_max"],
        durationDaysByPlan: { matrix_starter: 14, matrix_builder: 3, matrix_max: 3 },
      },
    };
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(status),
    } as unknown as Response);
    await expect(fetchMobileBillingStatus("clerk-token", "primary")).resolves.toEqual({
      ...status, activeCheckout: null,
    });
  });

  it("accepts the public portal capability without a Stripe subscription identifier", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(overrideBillingStatus),
    } as unknown as Response);

    await expect(fetchMobileBillingStatus("clerk-token", "primary")).resolves.toEqual(
      overrideBillingStatus,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/billing/status?runtimeSlot=primary&trialOfferVersion=2",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
