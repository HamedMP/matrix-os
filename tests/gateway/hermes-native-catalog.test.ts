import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AiNativeHarnessCatalogSchema } from "@matrix-os/contracts";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { projectHermesNativeCatalog } from "../../packages/gateway/src/ai-providers/hermes-native-catalog.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createCanonicalNativeHarnessCatalogReader, projectCanonicalNativeHarnessCatalog } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";

const now = new Date("2026-09-28T00:00:00Z");
const native = () => normalizeHermesRuntimeSnapshot({
  observedAt: +now,
  status: { gateway_running: true },
  options: { provider: "openai-codex", model: "gpt-5.6-sol", providers: [{
    slug: "openai-codex", name: "OpenAI Codex", authenticated: true, auth_type: "oauth",
    models: ["gpt-5.6-sol", "gpt-5.6-luna"],
  }] },
});

describe("Hermes-owned native subscription catalog", () => {
  it("rejects non-Codex Hermes profiles at the V3 catalog boundary", () => {
    expect(AiNativeHarnessCatalogSchema.safeParse({ profiles: [{
      harness: "hermes", providerId: "anthropic", providerDisplayName: "Anthropic",
      models: [{ id: "anthropic:claude", displayName: "Claude", enabled: true }], defaultModelId: "anthropic:claude",
      localObservation: { state: "unknown", checkedAt: null, staleAfter: null },
    }], failures: [] }).success).toBe(false);
  });
  it("preserves a full existing coding catalog when no bounded slot remains for Hermes", async () => {
    const coding = projectCanonicalNativeHarnessCatalog(AiNativeHarnessCatalogSchema.parse({
      profiles: Array.from({ length: 48 }, (_, i) => ({ harness: "pi", providerId: `native_${i}`,
        providerDisplayName: `Native ${i}`, models: [{ id: `native_${i}:model`, displayName: "Model", enabled: true }],
        defaultModelId: null, localObservation: { state: "unknown", checkedAt: null, staleAfter: null } })), failures: [],
    }));
    const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => coding }, { hermesRuntimeSource: async () => native(), now: () => now });
    const result = await reader(false);
    expect(result.profiles).toHaveLength(48);
    expect(result.failures).toEqual(["hermes"]);
  });
  it.each(["contradictory_auth", "inactive_runtime", "prefixed_native_model"] as const)("rejects inconsistent native metadata (%s)", (reason) => {
    const snapshot = native();
    if (reason === "contradictory_auth") snapshot.providers[0]!.authStatus = { state: "action_required", authenticated: false, action: "open_login_terminal" };
    if (reason === "inactive_runtime") snapshot.runtime.selected = "openclaw";
    if (reason === "prefixed_native_model") {
      snapshot.providers[0]!.models[0]!.id = "openai-codex:gpt-5.6-sol";
      snapshot.messaging.model = "openai-codex:gpt-5.6-sol";
      snapshot.runtime.options[0]!.nativeRouteObservation!.modelId = "openai-codex:gpt-5.6-sol";
    }
    expect(projectHermesNativeCatalog(snapshot, now).profiles).toEqual([]);
  });
  it.each(["missing_observation", "wrong_credential", "stale", "future", "excess_ttl", "missing_model", "duplicate_model", "duplicate_provider"] as const)("fails closed on insufficient native metadata (%s)", (reason) => {
    const snapshot = native();
    const runtime = snapshot.runtime.options[0]!;
    if (reason === "missing_observation") delete runtime.nativeRouteObservation;
    if (reason === "wrong_credential") runtime.nativeRouteObservation!.credentialKind = "api_key";
    if (reason === "stale") runtime.nativeRouteObservation!.localObservation.staleAfter = now.toISOString();
    if (reason === "future") runtime.nativeRouteObservation!.localObservation.checkedAt = "2026-09-28T00:00:01Z";
    if (reason === "excess_ttl") runtime.nativeRouteObservation!.localObservation.staleAfter = "2026-09-28T00:01:00Z";
    if (reason === "missing_model") snapshot.providers[0]!.models.shift();
    if (reason === "duplicate_model") snapshot.providers[0]!.models.push(snapshot.providers[0]!.models[0]!);
    if (reason === "duplicate_provider") snapshot.providers.push(snapshot.providers[0]!);
    expect(projectHermesNativeCatalog(snapshot, now)).toEqual({ profiles: [], failures: ["hermes"] });
  });
  it("projects the selected native Codex inventory without claiming remote readiness", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-catalog-"));
    const producer = new AiProviderService({
      homePath, env: {}, now: () => now,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: async () => native(),
      driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
        health: "ready", capabilities: ["tools"], setupActions: [] }],
    });
    try {
      const snapshot = await producer.getSnapshot();
      expect(snapshot.nativeHarnessCatalog).toMatchObject({ profiles: [{
        harness: "hermes", providerId: "openai-codex", defaultModelId: "openai-codex:gpt-5.6-sol",
        models: [{ id: "openai-codex:gpt-5.6-sol", enabled: true }, { id: "openai-codex:gpt-5.6-luna", enabled: true }],
        localObservation: { state: "present_unverified", checkedAt: now.toISOString(),
          staleAfter: "2026-09-28T00:00:05.000Z" },
      }], failures: [] });
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("offers the native Hermes source in Settings with no borrowed provider account", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-settings-"));
    const producer = new AiProviderService({ homePath, env: {}, now: () => now,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: async () => native(),
      driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
        health: "ready", capabilities: ["tools"], setupActions: [] }],
    });
    try {
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer });
      const snapshot = await store.getSnapshot();
      expect(snapshot.accessSources.find((source) => source.id === "harness_hermes_openai-codex")).toMatchObject({
        kind: "harness_profile", harness: "hermes", providerId: "openai-codex", accountId: null,
        fundingKind: "owner_account", readiness: { state: "unknown" },
        localObservation: { state: "present_unverified" },
        eligibleModelIds: ["openai-codex:gpt-5.6-sol", "openai-codex:gpt-5.6-luna"],
      });
      expect(snapshot.harnesses.find((row) => row.harness === "hermes")).toMatchObject({
        enabled: true, selectedAccountId: null, accountIds: [], accessSourceId: "harness_hermes_openai-codex",
        route: { providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" }, authState: "unknown",
      });
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("preserves the exact runtime Codex inventory in Chat after Settings selection", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-chat-"));
    const producer = new AiProviderService({ homePath, env: {}, now: () => now,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: async () => native(),
      driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
        health: "ready", capabilities: ["tools"], setupActions: [] }],
    });
    try {
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer });
      const settings = await store.getSnapshot();
      const catalogSource = createChatProviderCatalogService({ now: () => now,
        codingProviders: { listProviders: async () => [], invalidate: () => {} },
        agentRuntimeSource: async () => native(), aiProviderSource: producer,
        harnessSettingsSource: { getSnapshot: async () => settings }, executableDriverKinds: ["hermes"],
      });
      const principal = { userId: "test_owner", source: "jwt" as const };
      const catalog = await catalogSource.getCatalog(principal);
      const instance = catalog.instances.find((row) => row.driverKind === "hermes")!;
      expect(instance.models.map((model) => model.id)).toEqual(["openai-codex:gpt-5.6-sol", "openai-codex:gpt-5.6-luna"]);
      expect(instance.defaultSelection?.model).toBe("openai-codex:gpt-5.6-sol");
      expect(validateChatProviderSelection({ catalog, selection: { instanceId: instance.id, model: "openai-codex:gpt-5.6-luna" } })).toMatchObject({ ok: true });
      settings.harnesses.find((row) => row.harness === "hermes")!.accessSourceId = "foreign_pi_profile";
      settings.accessSources = settings.accessSources.filter((row) => row.harness !== "hermes");
      const blocked = await catalogSource.refresh(principal);
      expect(blocked.instances.find((row) => row.driverKind === "hermes")).toMatchObject({ availability: "unavailable", models: [] });
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("supports explicit native model changes without accounts and preserves a saved off switch", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-mutation-"));
    const producer = new AiProviderService({ homePath, env: {}, now: () => now,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: async () => native(),
      driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
        health: "ready", capabilities: ["tools"], setupActions: [] }],
    });
    const applyConfiguration = vi.fn(async () => undefined);
    try {
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer,
        runtimeCoordinator: { supportedActions: ["set_route", "set_harness_enabled"], supportedHarnessKinds: ["hermes"],
          isRecoveryReady: () => true, reconcilePending: async () => undefined, applyConfiguration,
          rollbackConfiguration: async () => undefined } });
      const before = await store.getSnapshot();
      const result = await store.mutate({ type: "set_route", expectedRevision: before.revision, idempotencyKey: "native_model_change",
        harnessInstanceId: "harness_hermes", accessSourceId: "harness_hermes_openai-codex", accountId: null,
        route: { kind: "configurable", providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-luna" }, enableHarness: true });
      expect(result.snapshot.harnesses.find((row) => row.harness === "hermes")).toMatchObject({ enabled: true,
        selectedAccountId: null, route: { modelId: "openai-codex:gpt-5.6-luna" }, authState: "unknown" });
      expect(applyConfiguration).toHaveBeenCalledTimes(1);
      const off = await store.mutate({ type: "set_harness_enabled", expectedRevision: result.snapshot.revision,
        idempotencyKey: "native_off", harnessInstanceId: "harness_hermes", enabled: false });
      expect(off.snapshot.harnesses.find((row) => row.harness === "hermes")).toMatchObject({ enabled: false, configuredEnabled: false });
      expect((await store.getSnapshot()).harnesses.find((row) => row.harness === "hermes")).toMatchObject({ enabled: false, configuredEnabled: false });
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("does not authorize Hermes when its required Settings source cannot be read", async () => {
    const service = createChatProviderCatalogService({ now: () => now,
      codingProviders: { listProviders: async () => [], invalidate: () => {} }, agentRuntimeSource: async () => native(),
      harnessSettingsSource: { getSnapshot: async () => { throw new Error("synthetic unavailable Settings"); } },
      executableDriverKinds: ["hermes"],
    });
    const result = await service.getCatalog({ userId: "test_owner", source: "jwt" });
    expect(result.instances.find((row) => row.driverKind === "hermes")).toMatchObject({ availability: "unavailable", models: [], unavailabilityReason: "settings_unavailable" });
  });
  it("preserves legacy native Chat composition without a Settings dependency", async () => {
    const service = createChatProviderCatalogService({ now: () => now,
      codingProviders: { listProviders: async () => [], invalidate: () => {} },
      agentRuntimeSource: async () => native(), executableDriverKinds: ["hermes"],
    });
    const result = await service.getCatalog({ userId: "test_owner", source: "jwt" });
    expect(result.instances.find((row) => row.driverKind === "hermes")).toMatchObject({ availability: "available",
      defaultSelection: { model: "openai-codex:gpt-5.6-sol" } });
  });
});
