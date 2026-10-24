import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialProviderSettingsConfiguration, readProviderSettingsConfiguration, writeProviderJsonAtomic } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { bindNativeAccountMetadata, verifyNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { normalizeClaudeNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { projectProviderSettings } from "../../packages/gateway/src/ai-providers/provider-settings-projector.js";
import { providerSettingsCanonicalFixture, providerSettingsFundingSummaryFixture, PROVIDER_SETTINGS_NOW as now } from "./provider-settings-test-support.js";

function nativeFixture() {
  const canonical = providerSettingsCanonicalFixture();
  const unknown = { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const };
  canonical.accessSources.push({ ...canonical.accessSources[1]!, id: "owner_claude_profile", ...unknown });
  canonical.accounts.push({ ...canonical.accounts[0]!, id: "owner_claude_profile", ...unknown });
  canonical.instances.push({ ...canonical.instances[1]!, id: "claude_code_owner_profile", driverId: "claude_code", accessSourceId: "owner_claude_profile", accountId: "owner_claude_profile", readiness: unknown });
  for (const model of canonical.models) model.eligibleAccessSourceIds.push("owner_claude_profile");
  return canonical;
}
async function reconcile(config: ReturnType<typeof initialProviderSettingsConfiguration>, canonical: ReturnType<typeof nativeFixture>) {
  const directory = await mkdtemp(join(tmpdir(), "claude-defaults-"));
  try {
    const path = join(directory, "settings.json");
    await writeProviderJsonAtomic(path, config);
    return await readProviderSettingsConfiguration(path, canonical, undefined, now);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const claude = (config: ReturnType<typeof initialProviderSettingsConfiguration>) => config.harnesses.find(h => h.harness === "claude")!;
const project = (canonical: ReturnType<typeof nativeFixture>, config = initialProviderSettingsConfiguration(canonical)) => {
  const { funding, policy } = providerSettingsFundingSummaryFixture();
  return projectProviderSettings({ canonical, config, now, supportedActions: [], fundingSummary: funding, fundedPolicy: policy, fundedPolicyAuthoritative: true });
};

describe("native Claude defaults and legacy Matrix bindings", () => {
  it("uses the exact native account even when the active Matrix route is ready", async () => {
    const canonical = nativeFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    expect(claude(config)).toMatchObject({ driverId: "claude_code", accessSourceId: "owner_claude_profile", selectedAccountId: "owner_claude_profile", route: { modelId: "claude-opus-5" } });
    expect((await project(canonical, config)).harnesses.find(h => h.harness === "claude")).toMatchObject({ authState: "unknown", connectivity: "unknown" });
  });
  it("retains verified native authentication with Matrix credit available", async () => {
    const canonical = nativeFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    const metadata = normalizeClaudeNativeAccountMetadata({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "owner@example.invalid", configDirectory: "/synthetic/.claude" }, "/synthetic", now)!;
    const verified = await verifyNativeAccountMetadata(bindNativeAccountMetadata(metadata, async () => true));
    const snapshot = await projectProviderSettings({ canonical, config, now, supportedActions: [], claudeNativeAccountMetadata: verified });
    expect(snapshot.harnesses.find(h => h.harness === "claude")).toMatchObject({ authState: "authenticated", accessSourceId: "owner_claude_profile", selectedAccountId: "owner_claude_profile" });
  });
  it("retains an active owner API key as the new default", () => {
    const canonical = nativeFixture();
    canonical.accessSources.push({ ...canonical.accessSources[1]!, id: "owner_anthropic_key", fundingKind: "owner_api_key" });
    canonical.instances.push({ ...canonical.instances[1]!, id: "claude_key", driverId: "claude_code", accessSourceId: "owner_anthropic_key" });
    canonical.active.accessSourceId = "owner_anthropic_key";
    expect(claude(initialProviderSettingsConfiguration(canonical))).toMatchObject({ accessSourceId: "owner_anthropic_key", selectedAccountId: "owner_anthropic" });
  });
  it("never generates a native Claude binding from Matrix-only inventory", () => {
    const canonical = providerSettingsCanonicalFixture();
    canonical.accessSources = [canonical.accessSources[0]!];
    canonical.accounts = [];
    canonical.instances = [canonical.instances[0]!];
    expect(claude(initialProviderSettingsConfiguration(canonical))).toBeUndefined();
  });
  it.each([true, false])("fails closed for a saved Matrix binding without rewriting owner intent (enabled=%s)", async enabled => {
    const canonical = nativeFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    Object.assign(claude(config), { accessSourceId: "matrix_included", selectedAccountId: null, enabled, route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" } });
    const original = structuredClone(config);
    expect(await reconcile(config, canonical)).toEqual(original);
    const snapshot = await project(canonical, config);
    expect(snapshot.harnesses.find(h => h.harness === "claude")).toMatchObject({ configuredEnabled: enabled, configuredAccessSourceId: "matrix_included", enabled: false, authState: "unknown", connectivity: "unknown", accessSourceId: null });
    expect(config).toEqual(original);
    expect(snapshot.accessSources.find(s => s.id === "matrix_included")?.readiness.state).toBe("ready");
  });
  it("preserves an explicit owner profile, model, and Off state", async () => {
    const canonical = nativeFixture();
    const config = initialProviderSettingsConfiguration(canonical);
    Object.assign(claude(config), { enablementOrigin: "owner_configuration", enabled: false, accessSourceId: "owner_anthropic_profile", selectedAccountId: "owner_anthropic", route: { kind: "fixed", providerId: "anthropic", modelId: "claude-sonnet-5" } });
    const original = structuredClone(config);
    expect(await reconcile(config, canonical)).toEqual(original);
  });
});
