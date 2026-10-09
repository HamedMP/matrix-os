import { expect, it } from "vitest";
import { isSupportedGenericHarnessCredentialRoute, type ProviderAccessSource, type ProviderHarnessKind, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { applyProviderConfigurationMutation } from "../../packages/gateway/src/ai-providers/provider-settings-mutations.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const kinds: ProviderHarnessKind[] = ["claude", "codex", "hermes", "openclaw", "pi", "opencode"];
const route = { kind: "configurable" as const, providerId: "openai", modelId: "gpt-own" };
const source = { id: "matrix_chatgpt_plan", kind: "provider_account", fundingKind: "owner_account", providerId: "openai", accountId: "account-own", eligibleModelIds: ["gpt-own"] } as ProviderAccessSource;

it.each(kinds)("shared route predicate excludes paired-device authority from %s", harness => {
  expect(isSupportedGenericHarnessCredentialRoute({ harness, route, accessSourceId: source.id }, source)).toBe(false);
});
it.each(["claude", "codex", "hermes", "openclaw"] as const)("preserves existing ordinary account support for %s", harness => {
  expect(isSupportedGenericHarnessCredentialRoute({ harness, route, accessSourceId: "ordinary" }, { ...source, id: "ordinary" })).toBe(true);
});
it.each(kinds)("native %s mutations refuse paired-device routes without altering owner configuration", harness => {
  const original: ProviderSettingsConfiguration = { schemaVersion: 1, revision: 0, accountProfiles: [], gatewayPolicy: null, receipts: [], harnesses: [{ id: "native", driverId: harness, harness, displayName: harness, accentColor: null, enabled: false, selectedAccountId: null, accessSourceId: null, route }] };
  const snapshot = { accessSources: [source], accounts: [{ id: "account-own" }], gatewayPolicy: null } as unknown as ProviderSettingsSnapshot;
  const base = { expectedRevision: 0, idempotencyKey: "paired_source" };
  for (const mutation of [
    { ...base, type: "add_harness" as const, harness, displayName: harness, route, accessSourceId: source.id, accountId: source.accountId },
    { ...base, type: "set_route" as const, harnessInstanceId: "native", route, accessSourceId: source.id, accountId: source.accountId },
    { ...base, type: "select_access_source" as const, harnessInstanceId: "native", accessSourceId: source.id },
    { ...base, type: "select_account" as const, harnessInstanceId: "native", accountId: source.accountId! },
  ]) {
    const config = structuredClone(original);
    expect(() => applyProviderConfigurationMutation({ mutation, config, snapshot, canonical: providerSettingsCanonicalFixture(), id: () => "new" })).toThrow("invalid_route");
    expect(config).toEqual(original);
  }
});
