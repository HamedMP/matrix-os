jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

import { fetchMobileBillingStatus } from "@/lib/requests/settings";

const overrideBillingStatus = {
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

  it("accepts the public portal capability without a Stripe subscription identifier", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(overrideBillingStatus),
    } as unknown as Response);

    await expect(fetchMobileBillingStatus("clerk-token", "primary")).resolves.toEqual(
      overrideBillingStatus,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/billing/status?runtimeSlot=primary&details=management",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
