import { describe, expect, it } from "vitest";
import type {
  AiProviderSnapshotV3,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { applyProviderConfigurationMutation } from "../../packages/gateway/src/ai-providers/provider-settings-mutations.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

describe("provider settings configuration mutations", () => {
  it("switches provider, model, source, and account as one route mutation", () => {
    const config = {
      version: 1,
      revision: 0,
      harnesses: [{
        id: "harness_generic",
        driverId: "kernel",
        harness: "opencode" as const,
        displayName: "OpenCode",
        accentColor: null,
        enabled: true,
        selectedAccountId: "account_anthropic",
        accessSourceId: "source_anthropic",
        route: { kind: "configurable" as const, providerId: "anthropic", modelId: "anthropic/claude" },
      }],
      accountProfiles: [],
      gatewayPolicy: null,
      receipts: [],
    } satisfies ProviderSettingsConfiguration;
    const snapshot = {
      accessSources: [{
        id: "source_openai",
        kind: "provider_account",
        providerId: "openai",
        accountId: "account_openai",
        eligibleModelIds: ["openai/gpt-5.6"],
      }],
      accounts: [{ id: "account_openai" }],
      gatewayPolicy: null,
    } as unknown as ProviderSettingsSnapshot;

    expect(applyProviderConfigurationMutation({
      mutation: {
        type: "set_route",
        expectedRevision: 0,
        idempotencyKey: "route_openai_1",
        harnessInstanceId: "harness_generic",
        route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
        accessSourceId: "source_openai",
        accountId: "account_openai",
      },
      config,
      canonical: providerSettingsCanonicalFixture() as AiProviderSnapshotV3,
      snapshot,
      id: () => "unused",
    })).toBe(true);
    expect(config.harnesses[0]).toMatchObject({
      route: { providerId: "openai", modelId: "openai/gpt-5.6" },
      accessSourceId: "source_openai",
      selectedAccountId: "account_openai",
    });
  });

  it("rejects an incoherent final account/source tuple without partially changing the harness", () => {
    const originalHarness = {
      id: "harness_generic",
      driverId: "kernel",
      harness: "hermes" as const,
      displayName: "Hermes",
      accentColor: null,
      enabled: true,
      selectedAccountId: null,
      accessSourceId: "source_matrix",
      route: { kind: "configurable" as const, providerId: "anthropic", modelId: "anthropic/claude" },
    };
    const config = {
      version: 1,
      revision: 0,
      harnesses: [structuredClone(originalHarness)],
      accountProfiles: [],
      gatewayPolicy: null,
      receipts: [],
    } satisfies ProviderSettingsConfiguration;
    const snapshot = {
      accessSources: [{
        id: "source_openai",
        kind: "provider_account",
        providerId: "openai",
        accountId: "account_openai",
        eligibleModelIds: ["openai/gpt-5.6"],
      }],
      accounts: [{ id: "account_other" }],
      gatewayPolicy: null,
    } as unknown as ProviderSettingsSnapshot;

    expect(() => applyProviderConfigurationMutation({
      mutation: {
        type: "set_route",
        expectedRevision: 0,
        idempotencyKey: "route_openai_invalid_1",
        harnessInstanceId: "harness_generic",
        route: { kind: "configurable", providerId: "openai", modelId: "openai/gpt-5.6" },
        accessSourceId: "source_openai",
        accountId: "account_other",
      },
      config,
      canonical: providerSettingsCanonicalFixture(),
      snapshot,
      id: () => "unused",
    })).toThrow("invalid_route");
    expect(config.harnesses[0]).toEqual(originalHarness);
  });
});
