import { describe, expect, it } from "vitest";
import { ProviderAccessSourceSchema, type ProviderModelProvider } from "@matrix-os/contracts";
import { boundProviderSettingsModels } from "../../packages/gateway/src/ai-providers/provider-settings-model-catalog.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const models = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `openrouter:model-${i}`, displayName: `Model ${i}`, enabled: i !== 264,
}));
function config(ids: string[] = []): ProviderSettingsConfiguration {
  return { schemaVersion: 1, revision: 1, accountProfiles: [], gatewayPolicy: null, receipts: [],
    harnesses: ids.map((modelId, i) => ({ id: `harness_${i}`, driverId: "pi", harness: "pi", displayName: `Pi ${i}`,
      accentColor: null, enabled: false, selectedAccountId: null, accessSourceId: "harness_pi_openrouter",
      route: { kind: "configurable", providerId: "openrouter", modelId } })) };
}
function source(harness: "pi" | "opencode", eligibleModelIds: string[]) {
  return ProviderAccessSourceSchema.parse({ id: `harness_${harness}_openrouter`, kind: "harness_profile", harness,
    fundingKind: "owner_account", providerId: "openrouter", accountId: null, displayName: harness,
    eligibleModelIds, readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null } });
}

describe("bounded provider Settings model inventory", () => {
  it.each([0, 255, 256])("leaves an inventory of %i models unchanged", count => {
    const provider = { id: "openrouter", displayName: "OpenRouter", models: models(count) };
    const input = { modelProviders: [provider], sources: [source("pi", provider.models.map(m => m.id))],
      canonical: providerSettingsCanonicalFixture(), config: config() };
    expect(boundProviderSettingsModels(input)).toEqual({ modelProviders: input.modelProviders, sources: input.sources });
  });

  it("retains tail selections and native defaults without moving eligibility between harnesses or mutating evidence", () => {
    const provider = { id: "openrouter", displayName: "OpenRouter", models: models(267) };
    const input = { modelProviders: [provider], sources: [source("pi", ["openrouter:model-266"]),
      source("opencode", provider.models.slice(0, 256).map(m => m.id))],
      canonical: providerSettingsCanonicalFixture(), config: config(["openrouter:model-266"]),
      nativeDefaults: { pi: "openrouter:model-265" } };
    const before = structuredClone(input);
    const result = boundProviderSettingsModels(input);
    expect(input).toEqual(before);
    expect(result.modelProviders[0]!.models).toHaveLength(256);
    expect(result.modelProviders[0]!.models.map(m => m.id)).toEqual([
      ...provider.models.slice(0, 254).map(m => m.id), "openrouter:model-265", "openrouter:model-266",
    ]);
    expect(result.sources[0]!.eligibleModelIds).toEqual(["openrouter:model-266"]);
    expect(result.sources[1]!.eligibleModelIds).toEqual(provider.models.slice(0, 254).map(m => m.id));
    expect(boundProviderSettingsModels({ ...input, ...result })).toEqual(result);
  });

  it("keeps the maximum 128 canonical models and 128 saved selections ahead of optional defaults", () => {
    const all = models(512);
    const canonical = providerSettingsCanonicalFixture();
    canonical.models = all.slice(256, 384).map(model => ({ ...canonical.models[0]!, id: model.id, vendor: "openrouter" }));
    const required = all.slice(256).map(model => model.id);
    const result = boundProviderSettingsModels({ modelProviders: [{ id: "openrouter", displayName: "OpenRouter", models: all }],
      sources: [source("pi", required)], canonical, config: config(all.slice(384).map(m => m.id)),
      nativeDefaults: { pi: all[0]!.id } });
    expect(result.modelProviders[0]!.models.map(m => m.id)).toEqual(required);
    expect(result.sources[0]!.eligibleModelIds).toEqual(required);
  });

  it("preserves disabled model metadata and unrelated provider inventories", () => {
    const provider = { id: "openrouter", displayName: "OpenRouter", models: models(267) };
    const other: ProviderModelProvider = { id: "anthropic", displayName: "Anthropic", models: [
      { id: "claude-sonnet-5", displayName: "Sonnet", enabled: true, capabilities: ["tools"] },
    ] };
    const result = boundProviderSettingsModels({ modelProviders: [provider, other], sources: [],
      canonical: providerSettingsCanonicalFixture(), config: config(["openrouter:model-264"]) });
    expect(result.modelProviders[0]!.models.find(m => m.id === "openrouter:model-264")).toEqual(provider.models[264]);
    expect(result.modelProviders[1]).toBe(other);
  });
});
