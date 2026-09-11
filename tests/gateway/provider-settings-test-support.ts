import {
  AiProviderSnapshotV3Schema,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";

export const PROVIDER_SETTINGS_NOW = new Date("2026-08-30T10:00:00.000Z");
const LATER = "2026-08-30T10:05:00.000Z";
export const providerReady = {
  state: "ready" as const,
  checkedAt: PROVIDER_SETTINGS_NOW.toISOString(),
  staleAfter: LATER,
  action: "none" as const,
  safeReason: null,
};

export function providerSettingsCanonicalFixture(): AiProviderSnapshotV3 {
  return AiProviderSnapshotV3Schema.parse({
    contractVersion: 3,
    revision: 7,
    refreshedAt: PROVIDER_SETTINGS_NOW.toISOString(),
    accessSources: [
      {
        id: "matrix_included",
        displayName: "Matrix AI",
        fundingKind: "matrix_included",
        vendor: "anthropic",
        accountLabel: "Included",
        eligibleModelIds: ["claude-sonnet-5"],
        policyVersion: "policy_1",
        ...providerReady,
      },
      {
        id: "owner_anthropic_profile",
        displayName: "Anthropic account",
        fundingKind: "owner_account",
        vendor: "anthropic",
        accountLabel: "Personal",
        eligibleModelIds: ["claude-sonnet-5", "claude-opus-5"],
        policyVersion: "policy_1",
        ...providerReady,
      },
    ],
    accounts: [{
      id: "owner_anthropic",
      vendor: "anthropic",
      authMethod: "provider_profile",
      accountLabel: "Personal",
      ...providerReady,
    }],
    drivers: [
      {
        id: "kernel",
        displayName: "Claude SDK",
        kind: "agent_sdk",
        installState: "installed",
        health: "ready",
        capabilities: ["tools", "resume"],
        setupActions: [],
      },
      {
        id: "claude_code",
        displayName: "Claude",
        kind: "cli",
        installState: "installed",
        health: "ready",
        capabilities: ["tools", "resume"],
        setupActions: [],
      },
    ],
    instances: [
      {
        id: "kernel_matrix",
        driverId: "kernel",
        vendor: "anthropic",
        accountId: null,
        accessSourceId: "matrix_included",
        label: "Matrix AI",
        readiness: providerReady,
        capabilitySnapshot: ["tools", "resume"],
        modelIds: ["claude-sonnet-5"],
        defaultModelId: "claude-sonnet-5",
        catalogVersion: "catalog_1",
      },
      {
        id: "kernel_owner",
        driverId: "kernel",
        vendor: "anthropic",
        accountId: "owner_anthropic",
        accessSourceId: "owner_anthropic_profile",
        label: "Personal Anthropic",
        readiness: providerReady,
        capabilitySnapshot: ["tools", "resume"],
        modelIds: ["claude-sonnet-5", "claude-opus-5"],
        defaultModelId: "claude-opus-5",
        catalogVersion: "catalog_1",
      },
    ],
    models: [
      {
        id: "claude-sonnet-5",
        vendor: "anthropic",
        displayName: "Claude Sonnet 5",
        status: "current",
        capabilities: ["tools", "reasoning"],
        effortControls: ["low", "high"],
        eligibleAccessSourceIds: ["matrix_included", "owner_anthropic_profile"],
        dataPolicies: [
          { accessSourceId: "matrix_included", route: "matrix_relay", disclosureKey: "matrix-anthropic" },
          { accessSourceId: "owner_anthropic_profile", route: "owner_direct", disclosureKey: "owner-anthropic" },
        ],
        aliases: [],
        catalogVersion: "catalog_1",
      },
      {
        id: "claude-opus-5",
        vendor: "anthropic",
        displayName: "Claude Opus 5",
        status: "current",
        capabilities: ["tools", "reasoning"],
        effortControls: ["high"],
        eligibleAccessSourceIds: ["owner_anthropic_profile"],
        dataPolicies: [{
          accessSourceId: "owner_anthropic_profile",
          route: "owner_direct",
          disclosureKey: "owner-anthropic",
        }],
        aliases: [],
        catalogVersion: "catalog_1",
      },
    ],
    active: {
      providerInstanceId: "kernel_matrix",
      accessSourceId: "matrix_included",
      modelId: "claude-sonnet-5",
    },
  });
}
