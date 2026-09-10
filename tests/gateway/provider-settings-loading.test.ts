import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { readProviderSettingsEnrichment } from "../../packages/gateway/src/ai-providers/provider-settings-enrichment.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

let homePath: string;
afterEach(async () => { if (homePath) await rm(homePath, { recursive: true, force: true }); });

it("starts independent model discovery while the funding summary is still pending", async () => {
  homePath = await mkdtemp(join(tmpdir(), "provider-loading-"));
  const funding = Promise.withResolvers<never>();
  const getFundingSummary = vi.fn(() => funding.promise);
  const getCatalog = vi.fn(async () => ({ providers: [], accessSources: [], failures: [] }));
  const store = new ProviderSettingsStore({
    homePath,
    now: () => PROVIDER_SETTINGS_NOW,
    providerSnapshotReader: { getSnapshot: async () => providerSettingsCanonicalFixture() },
    fundingSummaryReader: { getFundingSummary },
    genericModelCatalogReader: { getCatalog },
  });
  const request = store.getSnapshot({ refresh: true });
  try {
    await vi.waitFor(() => expect(getFundingSummary).toHaveBeenCalledOnce());
    expect(getCatalog).toHaveBeenCalledWith({ refresh: true });
  } finally {
    funding.reject(new Error("Funding unavailable"));
    const snapshot = await request;
    // Concurrent discovery is not permission to fall back to local credit.
    expect(snapshot.gatewayPolicy?.allowedModelIds).toEqual([]);
    expect(snapshot.accessSources.find((source) => source.id === "matrix_included")?.eligibleModelIds).toEqual([]);
  }
});

it("does not project prefetched funding when canonical inventory has no Matrix source", async () => {
  const inventory = Promise.withResolvers<AiProviderSnapshotV3>();
  const getFundingSummary = vi.fn(async () => ({
    funding: {
      asOf: PROVIDER_SETTINGS_NOW.toISOString(), periodStart: "2026-08-01T00:00:00.000Z",
      monthlyBudgetMicrousd: 5_000_000, settledThisMonthMicrousd: 0,
      reservedMicrousd: 0, reservedThisMonthMicrousd: 0,
      promotionalBalanceMicrousd: 1_000_000, addonBalanceMicrousd: 0,
      creditBalanceMicrousd: 1_000_000, fundingShortfallMicrousd: 0,
      remainingBalanceMicrousd: 1_000_000, remainingBudgetMicrousd: 5_000_000,
    },
    policy: {
      enabled: true, globalRevision: 1, runtimeRevision: 1,
      allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 5_000_000,
      checkedAt: PROVIDER_SETTINGS_NOW.toISOString(), staleAfter: "2026-08-30T10:01:00.000Z",
    },
  }));
  const request = readProviderSettingsEnrichment({
    canonical: inventory.promise, fundingSummary: { getFundingSummary }, refresh: false,
  });
  expect(getFundingSummary).toHaveBeenCalledOnce();
  const canonical = providerSettingsCanonicalFixture();
  inventory.resolve({ ...canonical, accessSources: canonical.accessSources.filter((source) =>
    source.fundingKind !== "matrix_included" && source.fundingKind !== "matrix_addon") });
  expect(await request).toEqual({ genericModelCatalog: undefined });
});

it("starts funding and model discovery before canonical inventory finishes, without borrowing readiness", async () => {
  homePath = await mkdtemp(join(tmpdir(), "provider-loading-"));
  const inventory = Promise.withResolvers<AiProviderSnapshotV3>();
  const getSnapshot = vi.fn(() => inventory.promise);
  const getFundingSummary = vi.fn(async () => { throw new Error("Funding unavailable"); });
  const getCatalog = vi.fn(async () => ({ providers: [], accessSources: [], failures: [] }));
  const store = new ProviderSettingsStore({
    homePath, now: () => PROVIDER_SETTINGS_NOW,
    providerSnapshotReader: { getSnapshot },
    fundingSummaryReader: { getFundingSummary }, genericModelCatalogReader: { getCatalog },
  });
  const request = store.getSnapshot({ refresh: true });
  try {
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    expect(getFundingSummary).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledWith({ refresh: true });
  } finally {
    inventory.resolve(providerSettingsCanonicalFixture());
    const snapshot = await request;
    expect(getFundingSummary).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(snapshot.gatewayPolicy?.allowedModelIds).toEqual([]);
    expect(snapshot.accessSources.find((source) => source.id === "matrix_included")?.eligibleModelIds).toEqual([]);
  }
});
