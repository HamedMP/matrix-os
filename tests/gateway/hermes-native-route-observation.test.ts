import { describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema } from "@matrix-os/contracts";
import { createHermesRuntimeSource } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { createProviderDriverInventoryReader } from "../../packages/gateway/src/ai-providers/provider-driver-inventory.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from "./provider-settings-test-support.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";

const observation = { providerId: "anthropic", modelId: "claude-sonnet-5", credentialKind: "provider_profile", localObservation: {
  state: "present_unverified", checkedAt: now.toISOString(), staleAfter: new Date(+now + 5000).toISOString(),
} } as const;

function input() {
  const canonical = providerSettingsCanonicalFixture();
  const source = canonical.accessSources.find(s => s.id === "owner_anthropic_profile")!;
  Object.assign(source, { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" });
  Object.assign(canonical.accounts[0]!, { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" });
  canonical.drivers.push({ ...canonical.drivers[1]!, id: "hermes", health: "degraded", nativeRouteObservation: structuredClone(observation) } as never);
  const config: ProviderSettingsConfiguration = { schemaVersion: 1, revision: 1, receipts: [],
    accountProfiles: [{ id: "owner_anthropic", providerId: "anthropic", authMethod: "terminal", displayName: "Anthropic account", accessSourceId: source.id }],
    harnesses: [{ id: "hermes_owner", driverId: "hermes", harness: "hermes", displayName: "Hermes", accentColor: null,
      enabled: true, selectedAccountId: "owner_anthropic", accessSourceId: source.id,
      route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" } }],
    gatewayPolicy: { accessSourceId: "matrix_included", allowedModelIds: ["claude-sonnet-5"], monthlyBudgetMicrousd: 1_000_000, topUpEnabled: false } };
  return { canonical, config, now, supportedActions: [] };
}

describe("owner native Hermes route observations", () => {
  it("carries the original probe timestamps through cached reads and V3 driver inventory without requiring a messaging gateway", async () => {
    let time = +now;
    const readJson = vi.fn(async (path: string) => path === "/api/status" ? { gateway_running: false, version: "0.21.4" } : {
      provider: "anthropic", model: "claude-sonnet-5", providers: [{ slug: "anthropic", name: "Anthropic", authenticated: true, auth_type: null, models: ["claude-sonnet-5"] }],
    });
    const runtimeSource = createHermesRuntimeSource(readJson, { now: () => time });
    const read = createProviderDriverInventoryReader({ runtimeSource, detectAgentInstallations: async () => ({ agents: [] }) });
    const initial = await read(AbortSignal.timeout(1000));
    expect(initial[0]).toMatchObject({ id: "hermes", health: "degraded", nativeRouteObservation: observation });
    time += 4000;
    expect((await read(AbortSignal.timeout(1000)))[0]).toMatchObject({ nativeRouteObservation: observation });
    expect(readJson).toHaveBeenCalledTimes(2);
  });

  it("projects local evidence only on its selected native harness, leaving shared account and source readiness unknown", async () => {
    const value = input();
    value.canonical = AiProviderSnapshotV3Schema.parse(value.canonical);
    const snapshot = await projectProviderSettings(value);
    expect(snapshot.harnesses.find(h => h.harness === "hermes")).toMatchObject({ enabled: true, authState: "unknown", connectivity: "unknown", localObservation: observation.localObservation });
    expect(snapshot.accounts.find(a => a.id === "owner_anthropic")?.authState).toBe("unknown");
    expect(snapshot.accessSources.find(s => s.id === "owner_anthropic_profile")?.readiness.state).toBe("unknown");
    expect(snapshot.harnesses.filter(h => h.harness !== "hermes").every(h => !("localObservation" in h))).toBe(true);
  });

  it.each(["matrix", "other_account", "api_key", "model", "provider", "disabled", "missing", "unavailable", "future", "reversed", "overlong", "expired_auth", "invalid_key", "failed_account"] as const)("does not attribute local proof to %s", async (negative) => {
    const value = input(); const h = value.config.harnesses[0]!;
    const driver = value.canonical.drivers.at(-1)! as typeof value.canonical.drivers[number] & { nativeRouteObservation: typeof observation };
    if (negative === "matrix") { h.accessSourceId = "matrix_included"; h.selectedAccountId = null; }
    if (negative === "other_account") { h.selectedAccountId = "other_account"; value.config.accountProfiles[0]!.id = "other_account"; }
    if (negative === "api_key") driver.nativeRouteObservation = { ...observation, credentialKind: "api_key" } as never;
    if (negative === "model") h.route.modelId = "claude-opus-5";
    if (negative === "provider") driver.nativeRouteObservation = { ...observation, providerId: "openai" } as never;
    if (negative === "disabled") h.enabled = false;
    if (negative === "missing") driver.installState = "missing";
    if (negative === "unavailable") driver.health = "unavailable";
    if (negative === "future") driver.nativeRouteObservation = { ...observation, localObservation: { ...observation.localObservation, checkedAt: new Date(+now + 1).toISOString() } };
    if (negative === "reversed") driver.nativeRouteObservation = { ...observation, localObservation: { ...observation.localObservation, staleAfter: new Date(+now - 1).toISOString() } };
    if (negative === "overlong") driver.nativeRouteObservation = { ...observation, localObservation: { ...observation.localObservation, staleAfter: new Date(+now + 5001).toISOString() } };
    if (negative === "expired_auth") value.canonical.accessSources.find(s => s.id === "owner_anthropic_profile")!.state = "expired";
    if (negative === "invalid_key") value.canonical.accessSources.find(s => s.id === "owner_anthropic_profile")!.state = "invalid";
    if (negative === "failed_account") value.canonical.accounts[0]!.state = "invalid";
    const snapshot = await projectProviderSettings(value);
    expect(snapshot.harnesses.find(h => h.harness === "hermes")?.localObservation).toBeUndefined();
  });
});
