jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

import {
  fetchMobileBackupStatus,
  fetchMobileBillingStatus,
  fetchMobileSyncStatus,
} from "@/lib/requests/settings";

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
      "https://app.matrix-os.com/billing/status?runtimeSlot=primary",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("loads bounded backup health from the selected Matrix computer", async () => {
    const backupStatus = {
      schemaVersion: 1,
      scheduler: { enabled: true, active: true, nextDueAt: null },
      lastAttempt: null,
      lastSuccess: null,
      storageReachability: "reachable",
      freshness: "unknown",
      observedAt: 1_800_000_000_000,
    };
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: jest.fn(() => "256") },
      body: null,
      text: jest.fn().mockResolvedValue(JSON.stringify(backupStatus)),
    } as unknown as Response);

    await expect(fetchMobileBackupStatus(
      "clerk-token",
      "https://app.matrix-os.com/vm/ada/~runtime/secondary",
    )).resolves.toEqual(backupStatus);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/ada/~runtime/secondary/api/sync/backup-status",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("loads bounded remote sync health from the selected Matrix computer", async () => {
    const status = {
      connectedPeers: [],
      manifestVersion: 5,
      fileCount: 12,
      totalSize: 4096,
      lastSyncAt: 1_800_000_000_000,
      pendingConflicts: 3,
      protocolVersion: 3,
      capabilities: {
        stagedUploads: true,
        immutableBlobs: true,
        immutableManifestGenerations: true,
      },
    };
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: jest.fn(() => "512") },
      body: null,
      text: jest.fn().mockResolvedValue(JSON.stringify(status)),
    } as unknown as Response);

    await expect(fetchMobileSyncStatus("clerk-token", "https://matrix.example/vm/ada"))
      .resolves.toEqual(status);
  });
});
