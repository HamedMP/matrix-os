import { describe, expect, it } from "vitest";
import {
  AiProviderSnapshotV3Schema,
  type AiProviderSnapshotV3,
} from "@matrix-os/contracts";

const now = "2026-08-29T20:30:00.000Z";

function snapshotFixture(): AiProviderSnapshotV3 {
  return {
    contractVersion: 3,
    revision: 7,
    refreshedAt: now,
    accessSources: [{
      id: "matrix_included",
      displayName: "Matrix AI",
      fundingKind: "matrix_included",
      vendor: "anthropic",
      state: "ready",
      accountLabel: "Included",
      checkedAt: now,
      staleAfter: null,
      action: "none",
      safeReason: null,
      eligibleModelIds: ["claude-sonnet-5"],
      policyVersion: "bundled_2026_08_29",
    }],
    accounts: [{
      id: "owner_anthropic",
      vendor: "anthropic",
      authMethod: null,
      state: "setup_required",
      accountLabel: null,
      checkedAt: null,
      staleAfter: null,
      action: "connect",
      safeReason: null,
    }, {
      id: "owner_openrouter",
      vendor: "openrouter",
      authMethod: null,
      state: "setup_required",
      accountLabel: null,
      checkedAt: null,
      staleAfter: null,
      action: "connect",
      safeReason: null,
    }],
    drivers: [{
      id: "kernel",
      displayName: "Matrix Agent",
      kind: "agent_sdk",
      installState: "installed",
      health: "ready",
      capabilities: ["tools", "resume", "subagents", "vision", "reasoning", "cancellation"],
      setupActions: [],
    }],
    instances: [{
      id: "kernel_matrix_included",
      driverId: "kernel",
      vendor: "anthropic",
      accountId: null,
      accessSourceId: "matrix_included",
      label: "Matrix AI",
      readiness: {
        state: "ready",
        checkedAt: now,
        staleAfter: null,
        action: "none",
        safeReason: null,
      },
      capabilitySnapshot: ["tools", "resume", "subagents", "vision", "reasoning", "cancellation"],
      modelIds: ["claude-sonnet-5"],
      defaultModelId: "claude-sonnet-5",
      catalogVersion: "bundled_2026_08_29",
    }],
    models: [{
      id: "claude-sonnet-5",
      vendor: "anthropic",
      displayName: "Claude Sonnet 5",
      status: "current",
      capabilities: ["tools", "vision", "reasoning", "long_context"],
      effortControls: ["low", "medium", "high", "max"],
      eligibleAccessSourceIds: ["matrix_included"],
      dataPolicies: [{
        accessSourceId: "matrix_included",
        route: "matrix_relay",
        disclosureKey: "matrix-cloudflare-anthropic",
      }],
      aliases: [],
      catalogVersion: "bundled_2026_08_29",
    }],
    active: {
      providerInstanceId: "kernel_matrix_included",
      accessSourceId: "matrix_included",
      modelId: "claude-sonnet-5",
    },
  };
}

describe("AI provider snapshot V3", () => {
  it("keeps Matrix-funded readiness separate from owner account connection state", () => {
    const parsed = AiProviderSnapshotV3Schema.parse(snapshotFixture());

    expect(parsed.contractVersion).toBe(3);
    expect(parsed.accessSources[0]).toMatchObject({
      id: "matrix_included",
      state: "ready",
      accountLabel: "Included",
    });
    expect(parsed.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "owner_anthropic", state: "setup_required" }),
      expect.objectContaining({ id: "owner_openrouter", state: "setup_required" }),
    ]));
  });

  it("rejects duplicate identifiers and active references outside the snapshot", () => {
    const fixture = snapshotFixture();
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      accounts: [fixture.accounts[0], fixture.accounts[0]],
    }).success).toBe(false);
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      active: { ...fixture.active, modelId: "claude-unknown" },
    }).success).toBe(false);
  });

  it("requires instance models to be allowed by both the source and model policy", () => {
    const fixture = snapshotFixture();
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      accessSources: [{ ...fixture.accessSources[0], eligibleModelIds: [] }],
    }).success).toBe(false);
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      models: [{ ...fixture.models[0], eligibleAccessSourceIds: [] }],
    }).success).toBe(false);
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      models: [{ ...fixture.models[0], dataPolicies: [] }],
    }).success).toBe(false);
  });

  it("requires one truthful route disclosure for every eligible access source", () => {
    const fixture = snapshotFixture();
    fixture.accessSources.push({
      ...fixture.accessSources[0],
      id: "owner_anthropic_key",
      displayName: "Anthropic API key",
      fundingKind: "owner_api_key",
      accountLabel: null,
      state: "setup_required",
      checkedAt: null,
      action: "enter_api_key",
    });
    const dualSourceModel = {
      ...fixture.models[0],
      eligibleAccessSourceIds: ["matrix_included", "owner_anthropic_key"],
      dataPolicies: [
        ...fixture.models[0].dataPolicies,
        {
          accessSourceId: "owner_anthropic_key",
          route: "owner_direct" as const,
          disclosureKey: "owner-direct-anthropic",
        },
      ],
    };

    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      models: [dualSourceModel],
    }).success).toBe(true);
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      models: [{ ...dualSourceModel, dataPolicies: dualSourceModel.dataPolicies.slice(0, 1) }],
    }).success).toBe(false);
  });

  it("rejects credential-shaped fields and unsafe client labels", () => {
    const fixture = snapshotFixture();
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      accounts: [{ ...fixture.accounts[0], secretRef: "owner-secret" }],
    }).success).toBe(false);
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      accessSources: [{ ...fixture.accessSources[0], accountLabel: "api_key=sk-secret" }],
    }).success).toBe(false);
  });

  it("caps every externally rendered collection", () => {
    const fixture = snapshotFixture();
    expect(AiProviderSnapshotV3Schema.safeParse({
      ...fixture,
      accessSources: Array.from({ length: 17 }, (_, index) => ({
        ...fixture.accessSources[0],
        id: `matrix_included_${index}`,
      })),
    }).success).toBe(false);
  });
});
