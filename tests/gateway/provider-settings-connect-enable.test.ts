import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderSettingsMutationSchema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { applyProviderConfigurationMutation } from "../../packages/gateway/src/ai-providers/provider-settings-mutations.js";
import type { ProviderSettingsConfiguration } from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";

describe("connect and enable an installed agent", () => {
  it.each(["pi", "opencode"] as const)("persists and replays a single %s connect through the real coordinator", async (kind) => {
    const homePath = await mkdtemp(join(tmpdir(), "provider-connect-"));
    try {
      const canonical = providerSettingsCanonicalFixture();
      canonical.drivers.push({ ...canonical.drivers[1]!, id: kind });
      const coordinator = createProviderGenericHarnessCoordinator({
        homePath, enabledCodingHarnesses: [kind],
        runtimeController: { update: async () => { throw new Error("Coding agents must not change messaging runtime"); } },
        runtimeSource: async () => { throw new Error("Coding agents do not use messaging runtime"); },
      });
      const store = new ProviderSettingsStore({ homePath,
        providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
        runtimeCoordinator: coordinator, now: () => new Date(canonical.refreshedAt), idGenerator: () => "added",
      });
      const before = await store.getSnapshot();
      const agent = before.harnesses.find((harness) => harness.harness === kind)!;
      expect(agent.enabled).toBe(false);
      const mutation = { type: "set_route" as const, expectedRevision: before.revision,
        idempotencyKey: "connect_once", harnessInstanceId: agent.id,
        route: { kind: "configurable" as const, providerId: "anthropic", modelId: "claude-sonnet-5" },
        accessSourceId: "matrix_included", accountId: null, enableHarness: true };
      const result = await store.mutate(mutation);
      expect(result.snapshot.harnesses.find((harness) => harness.id === agent.id)).toMatchObject({
        enabled: true, accessSourceId: "matrix_included", route: mutation.route,
      });
      expect((await store.mutate(mutation)).snapshot.revision).toBe(result.snapshot.revision);
      expect((await store.getSnapshot()).harnesses.find((harness) => harness.id === agent.id)?.enabled).toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
  it.each(["pi", "opencode"] as const)("connects %s atomically, with explicit enable consent", (kind) => {
    const canonical = providerSettingsCanonicalFixture();
    canonical.drivers.push({ ...canonical.drivers[1]!, id: kind });
    const original = { schemaVersion: 1, revision: 0, accountProfiles: [], gatewayPolicy: null, receipts: [],
      harnesses: [{ id: "agent", driverId: kind, harness: kind, displayName: kind, accentColor: null,
        enabled: false, selectedAccountId: null, accessSourceId: null,
        route: { kind: "configurable", providerId: "anthropic", modelId: "old-model" } }],
    } as ProviderSettingsConfiguration;
    const snapshot = { accessSources: [{ id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included",
      providerId: "anthropic", accountId: null, eligibleModelIds: ["claude-sonnet-5"] }], accounts: [],
      gatewayPolicy: { allowedModelIds: ["claude-sonnet-5"] } } as unknown as ProviderSettingsSnapshot;
    const input = { type: "set_route", expectedRevision: 0, idempotencyKey: "connect_agent",
      harnessInstanceId: "agent", route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
      accessSourceId: "matrix_included", accountId: null, enableHarness: true };
    const mutation = ProviderSettingsMutationSchema.parse(input);
    const config = structuredClone(original);
    applyProviderConfigurationMutation({ mutation, config, canonical, snapshot, id: () => "unused" });
    expect(config.harnesses[0]).toMatchObject({ enabled: true, accessSourceId: "matrix_included", route: input.route });

    const preserved = structuredClone(original);
    applyProviderConfigurationMutation({ mutation: ProviderSettingsMutationSchema.parse({ ...input, enableHarness: undefined }),
      config: preserved, canonical, snapshot, id: () => "unused" });
    expect(preserved.harnesses[0]!.enabled).toBe(false);

    for (const invalid of ["missing_install", "invalid_model"] as const) {
      const unchanged = structuredClone(original);
      const runtime = structuredClone(canonical);
      if (invalid === "missing_install") runtime.drivers.find((driver) => driver.id === kind)!.installState = "missing";
      const request = ProviderSettingsMutationSchema.parse({ ...input,
        route: { ...input.route, modelId: invalid === "invalid_model" ? "not-allowed" : input.route.modelId } });
      expect(() => applyProviderConfigurationMutation({ mutation: request, config: unchanged, canonical: runtime, snapshot, id: () => "unused" })).toThrow();
      expect(unchanged).toEqual(original);
    }
  });
});
