import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
export function jevReadySettingsSnapshot(time = Date.now()) {
  return ProviderSettingsSnapshotSchema.parse({ contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: new Date(time).toISOString(), access: { mode: "writable" }, supportedActions: [],
    harnessCatalog: ["hermes", "openclaw", "pi", "opencode"].map((harness) => ({ harness, displayName: harness,
      installState: "installed", available: true, runnable: true, setupAction: "none", safeReason: null })),
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "claude-sonnet-5", displayName: "Sonnet", enabled: true }] }],
    accessSources: [{ id: "owner_anthropic_key", kind: "provider_account", providerId: "anthropic", fundingKind: "owner_api_key", accountId: "owner_anthropic",
      displayName: "Anthropic key", readiness: { state: "ready", checkedAt: new Date(time).toISOString(), staleAfter: new Date(time + 60_000).toISOString(), action: "none", safeReason: null },
      eligibleModelIds: ["claude-sonnet-5"], usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "account", reason: "provider_does_not_report", asOf: null } }],
    accounts: [{ id: "owner_anthropic", providerId: "anthropic", displayName: "Owner", authMethod: "api_key", authState: "authenticated", lastCheckedAt: new Date(time).toISOString(), accessSourceId: "owner_anthropic_key",
      dependencies: { activeChatCount: 0, resumableChatCount: 0, harnessInstanceCount: 1 } }],
    harnesses: [{ id: "harness_hermes", harness: "hermes", displayName: "Hermes", accentColor: null, enabled: true, version: "0.21.4", installState: "installed", authState: "authenticated",
      loginMethods: ["api_key"], recommendedLoginMethod: "api_key", connectivity: "online", accountIds: ["owner_anthropic"], selectedAccountId: "owner_anthropic", accessSourceId: "owner_anthropic_key",
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" }, activeChatCount: 0 }], gatewayPolicy: null });
}
