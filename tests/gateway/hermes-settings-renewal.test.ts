import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHermesRuntimeSource } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";

it("renews native evidence after independent Settings enrichment without repeating funding or credentials", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "hermes-settings-renewal-"));
  let clock = 0;
  const observed = Promise.withResolvers<void>();
  const funding = Promise.withResolvers<never>();
  const source = createHermesRuntimeSource(async path => {
    if (path === "/api/status") return { gateway_running: false };
    observed.resolve();
    return { provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }] };
  }, { now: () => clock });
  const producer = new AiProviderService({ homePath, env: {}, now: () => new Date(clock),
    driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed", health: "ready", capabilities: ["tools"], setupActions: [] }],
    hermesRuntimeSource: source, nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) } });
  const canonicalDone = Promise.withResolvers<void>();
  const actualGetSnapshot = producer.getSnapshot.bind(producer);
  vi.spyOn(producer, "getSnapshot").mockImplementation(async options => {
    const result = await actualGetSnapshot(options); canonicalDone.resolve(); return result;
  });
  const getFundingSummary = vi.fn(() => funding.promise);
  const store = new ProviderSettingsStore({ homePath, privateRootPath: `${homePath}-private`, now: () => new Date(clock), providerSnapshotReader: producer,
    fundingSummaryReader: { getFundingSummary } });
  try {
    const pending = store.getSnapshot({ refresh: true });
    await observed.promise;
    await canonicalDone.promise;
    for (let i = 0; i < 30; i++) await Promise.resolve();
    clock = 6000; funding.reject(new Error("Funding unavailable"));
    const result = await pending;
    const hermes = result.harnesses.find(harness => harness.harness === "hermes");
    const profile = result.accessSources.find(source => source.id === hermes?.accessSourceId);
    expect(profile?.localObservation.checkedAt).toBe(new Date(6000).toISOString());
    expect(hermes?.enabled).toBe(true);
    expect(getFundingSummary).toHaveBeenCalledOnce();
  } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); await rm(`${homePath}-private`, { recursive: true, force: true }); }
});
