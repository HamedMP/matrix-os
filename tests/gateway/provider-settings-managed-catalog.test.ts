import { describe, expect, it } from "vitest";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { PROVIDER_SETTINGS_NOW as now, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

function projectionInput(harness: "pi" | "opencode") {
  const canonical = providerSettingsCanonicalFixture();
  canonical.drivers.push({ ...canonical.drivers[1]!, id: harness });
  const config: ProviderSettingsConfiguration = {
    schemaVersion: 1, revision: 1, accountProfiles: [], receipts: [],
    harnesses: [{
      id: `managed_${harness}`, driverId: harness, harness, displayName: harness,
      accentColor: null, enabled: true, selectedAccountId: null, accessSourceId: "matrix_included",
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
    }],
    gatewayPolicy: {
      accessSourceId: "matrix_included", allowedModelIds: ["claude-sonnet-5"],
      monthlyBudgetMicrousd: 1_000_000, topUpEnabled: false,
    },
  };
  return {
    canonical, config, now, supportedActions: [], fundedPolicyAuthoritative: true,
    fundedPolicy: {
      enabled: true, globalRevision: 1, runtimeRevision: 1,
      allowedModelIds: ["anthropic/claude-sonnet-5"], monthlyBudgetMicrousd: 1_000_000,
      checkedAt: now.toISOString(), staleAfter: "2026-08-30T10:01:00.000Z",
    },
    genericModelCatalog: { providers: [], accessSources: [], failures: [harness] },
  };
}

describe("Matrix routes during native model catalog failure", () => {
  it.each(["pi", "opencode"] as const)("preserves but disables the %s Matrix route until its catalog recovers", async (harness) => {
    const input = projectionInput(harness);
    const snapshot = await projectProviderSettings(input);
    expect(snapshot.harnesses.find((agent) => agent.harness === harness)).toMatchObject({
      enabled: false, accessSourceId: null, selectedAccountId: null,
      route: input.config.harnesses[0]!.route,
      routeAvailability: "catalog_unavailable", authState: "unknown", connectivity: "offline",
    });
  });

  it.each([
    "local_policy", "revoked", "expired_policy", "future_policy", "ineligible_policy",
    "ineligible_source", "relay_unavailable", "expired_source", "future_source", "retired_model", "own_account",
    "model_excludes_source",
  ] as const)("keeps %s fail-closed despite saved enabled state", async (failure) => {
    const input = projectionInput("pi");
    const source = input.canonical.accessSources.find((candidate) => candidate.id === "matrix_included")!;
    if (failure === "local_policy") input.fundedPolicyAuthoritative = false;
    if (failure === "revoked") input.fundedPolicy.enabled = false;
    if (failure === "expired_policy") input.fundedPolicy.staleAfter = now.toISOString();
    if (failure === "future_policy") input.fundedPolicy.checkedAt = "2026-08-30T10:01:00.000Z";
    if (failure === "ineligible_policy") input.fundedPolicy.allowedModelIds = [];
    if (failure === "ineligible_source") source.eligibleModelIds = [];
    if (failure === "relay_unavailable") { source.state = "unavailable"; source.action = "retry"; }
    if (failure === "expired_source") source.staleAfter = now.toISOString();
    if (failure === "future_source") source.checkedAt = "2026-08-30T10:01:00.000Z";
    if (failure === "model_excludes_source") input.canonical.models[0]!.eligibleAccessSourceIds = [];
    if (failure === "retired_model") input.canonical.models[0]!.status = "retired";
    if (failure === "own_account") {
      input.config.harnesses[0]!.accessSourceId = "owner_anthropic_profile";
      input.config.harnesses[0]!.selectedAccountId = "owner_anthropic";
    }
    const snapshot = await projectProviderSettings(input);
    expect(snapshot.harnesses.find((agent) => agent.harness === "pi")).toMatchObject({
      enabled: false, accessSourceId: null, routeAvailability: "catalog_unavailable",
    });
  });
});
