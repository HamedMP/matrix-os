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
        harness: "hermes" as const,
        displayName: "Hermes",
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

  it.each(["pi", "opencode"] as const)(
    "rejects a crafted %s route whose provider account is not a portable Anthropic API key",
    (kind) => {
      const originalHarness = {
        id: `harness_${kind}`,
        driverId: kind,
        harness: kind,
        displayName: kind === "pi" ? "Pi" : "OpenCode",
        accentColor: null,
        enabled: false,
        selectedAccountId: null,
        accessSourceId: "source_matrix",
        route: { kind: "configurable" as const, providerId: "anthropic", modelId: "claude-sonnet-5" },
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
          id: "source_subscription",
          kind: "provider_account",
          fundingKind: "owner_subscription",
          providerId: "anthropic",
          accountId: "account_subscription",
          eligibleModelIds: ["claude-sonnet-5"],
        }],
        accounts: [{ id: "account_subscription", accessSourceId: "source_subscription" }],
        gatewayPolicy: null,
      } as unknown as ProviderSettingsSnapshot;

      expect(() => applyProviderConfigurationMutation({
        mutation: {
          type: "set_route",
          expectedRevision: 0,
          idempotencyKey: `route_${kind}_subscription_1`,
          harnessInstanceId: originalHarness.id,
          route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
          accessSourceId: "source_subscription",
          accountId: "account_subscription",
        },
        config,
        canonical: providerSettingsCanonicalFixture(),
        snapshot,
        id: () => "unused",
      })).toThrow("invalid_route");
      expect(config.harnesses[0]).toEqual(originalHarness);

      expect(() => applyProviderConfigurationMutation({
        mutation: {
          type: "select_access_source",
          expectedRevision: 0,
          idempotencyKey: `source_${kind}_subscription_1`,
          harnessInstanceId: originalHarness.id,
          accessSourceId: "source_subscription",
        },
        config,
        canonical: providerSettingsCanonicalFixture(),
        snapshot,
        id: () => "unused",
      })).toThrow("invalid_route");
      expect(config.harnesses[0]).toEqual(originalHarness);

      expect(() => applyProviderConfigurationMutation({
        mutation: {
          type: "add_harness",
          expectedRevision: 0,
          idempotencyKey: `add_${kind}_subscription_1`,
          harness: kind,
          displayName: originalHarness.displayName,
          route: originalHarness.route,
          accessSourceId: "source_subscription",
          accountId: "account_subscription",
        },
        config: { ...config, harnesses: [] },
        canonical: providerSettingsCanonicalFixture(),
        snapshot,
        id: () => "new",
      })).toThrow("invalid_route");
    },
  );

  it("accepts an OpenCode-native model without pretending it is a portable API key", () => {
    const config = {
      schemaVersion: 1,
      revision: 0,
      harnesses: [{
        id: "harness_opencode",
        driverId: "opencode",
        harness: "opencode" as const,
        displayName: "OpenCode",
        accentColor: null,
        enabled: false,
        selectedAccountId: null,
        accessSourceId: "matrix_included",
        route: { kind: "configurable" as const, providerId: "anthropic", modelId: "claude-sonnet-5" },
      }],
      accountProfiles: [],
      gatewayPolicy: null,
      receipts: [],
    } satisfies ProviderSettingsConfiguration;
    const snapshot = {
      accessSources: [{
        id: "harness_opencode_baseten",
        kind: "harness_profile",
        harness: "opencode",
        fundingKind: "owner_account",
        providerId: "baseten",
        accountId: null,
        eligibleModelIds: ["baseten:zai-org/GLM-5.3"],
      }],
      accounts: [],
      gatewayPolicy: null,
    } as unknown as ProviderSettingsSnapshot;

    expect(applyProviderConfigurationMutation({
      mutation: {
        type: "set_route",
        expectedRevision: 0,
        idempotencyKey: "route_opencode_native_1",
        harnessInstanceId: "harness_opencode",
        route: { kind: "configurable", providerId: "baseten", modelId: "baseten:zai-org/GLM-5.3" },
        accessSourceId: "harness_opencode_baseten",
        accountId: null,
      },
      config,
      canonical: providerSettingsCanonicalFixture(),
      snapshot,
      id: () => "unused",
    })).toBe(true);
    expect(config.harnesses[0]).toMatchObject({
      route: { providerId: "baseten", modelId: "baseten:zai-org/GLM-5.3" },
      accessSourceId: "harness_opencode_baseten",
      selectedAccountId: null,
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
