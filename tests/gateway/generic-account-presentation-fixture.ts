import { type ProviderGenericHarnessKind, type ProviderAccessSource } from "@matrix-os/contracts";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

export const ACCOUNT_PRESENTATION_NOW = new Date("2026-09-27T00:00:00Z");
export async function nativeAccountPresentationFixture(harness: Extract<ProviderGenericHarnessKind, "pi" | "opencode">, catalogFailed = false) {
  const canonical = providerSettingsCanonicalFixture();
  canonical.refreshedAt = ACCOUNT_PRESENTATION_NOW.toISOString();
  const unknown = { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const };
  canonical.accounts.push({ id: "owner_codex", vendor: "openai", accountLabel: "Codex", authMethod: "provider_profile", ...unknown });
  canonical.accessSources.push({ id: "owner_openai_profile", vendor: "openai", displayName: "Codex account", accountLabel: "Codex",
    fundingKind: "owner_account", eligibleModelIds: ["fixture-sol"], policyVersion: "fixture", ...unknown });
  canonical.instances.push({ id: "codex_owner_openai_profile", driverId: "codex", vendor: "openai", accountId: "owner_codex",
    accessSourceId: "owner_openai_profile", label: "Codex", readiness: unknown, capabilitySnapshot: ["tools"], modelIds: ["fixture-sol"], defaultModelId: null, catalogVersion: "fixture" });
  canonical.models.push({ ...canonical.models[0]!, id: "fixture-sol", vendor: "openai", eligibleAccessSourceIds: ["owner_openai_profile"],
    dataPolicies: [{ accessSourceId: "owner_openai_profile", route: "owner_direct", disclosureKey: "fixture" }] });
  canonical.drivers.push({ id: "codex", displayName: "Codex", kind: "cli", installState: "installed", health: "unknown", capabilities: ["tools"], setupActions: [] });
  canonical.drivers.push({ id: harness, displayName: harness, kind: "cli", installState: "installed", health: "unknown", capabilities: ["tools"], setupActions: [] });
  const source: ProviderAccessSource = { id: `harness_${harness}_openai`, kind: "harness_profile", harness,
    providerId: "openai", displayName: `${harness} account`, accountId: null, fundingKind: "owner_account",
    eligibleModelIds: ["openai:fixture-sol"], readiness: unknown,
    localObservation: { state: "present_unverified", checkedAt: ACCOUNT_PRESENTATION_NOW.toISOString(), staleAfter: new Date(ACCOUNT_PRESENTATION_NOW.getTime() + 5000).toISOString() },
    usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source", reason: "provider_does_not_report", asOf: null } };
  return projectProviderSettings({ canonical, now: ACCOUNT_PRESENTATION_NOW, supportedActions: [],
    config: { schemaVersion: 1, revision: 1, accountProfiles: [], gatewayPolicy: null, receipts: [], harnesses: [{
      id: `harness_${harness}`, driverId: harness, harness, displayName: harness === "pi" ? "Pi" : "OpenCode", accentColor: null,
      enabled: true, selectedAccountId: null, accessSourceId: source.id,
      route: { kind: "configurable", providerId: "openai", modelId: "openai:fixture-sol" },
    }, { id: "harness_codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null,
      enabled: true, selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile",
      route: { kind: "fixed", providerId: "openai", modelId: "fixture-sol" },
    }] },
    genericModelCatalog: catalogFailed ? { providers: [], accessSources: [], failures: [harness] }
      : { providers: [{ id: "openai", displayName: "OpenAI", models: [{ id: "openai:fixture-sol", displayName: "Fixture Sol", enabled: true }] }], accessSources: [source], failures: [] },
  });
}
