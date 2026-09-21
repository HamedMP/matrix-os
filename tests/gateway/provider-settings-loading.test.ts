import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
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
