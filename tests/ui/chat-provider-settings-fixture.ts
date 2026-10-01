import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
export function disconnectedSnapshot(): ProviderSettingsSnapshot {
  return {
    contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: 1 },
    revision: 1, refreshedAt: new Date().toISOString(), access: { mode: "writable" }, supportedActions: ["start_login"],
    harnessCatalog: ["hermes", "openclaw", "pi", "opencode"].map((harness) => ({ harness: harness as "hermes", displayName: harness, installState: "missing", available: false, runnable: false, setupAction: "none", safeReason: "runtime_not_supported" })),
    modelProviders: [{ id: "anthropic", displayName: "Anthropic", models: [{ id: "sonnet", displayName: "Sonnet", enabled: true }] }],
    accessSources: [], accounts: [], gatewayPolicy: null,
    harnesses: ["claude", "codex"].map((harness) => ({ id: `${harness}_default`, harness: harness as "claude", displayName: harness === "claude" ? "Claude Code" : "Codex", accentColor: null, enabled: false, version: null, installState: "installed", authState: "unauthenticated", loginMethods: ["terminal"], recommendedLoginMethod: "terminal", connectivity: "offline", accountIds: [], selectedAccountId: null, accessSourceId: null, route: { kind: "fixed", providerId: "anthropic", modelId: "sonnet" }, activeChatCount: 0 })),
  };
}
