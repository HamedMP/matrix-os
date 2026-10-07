import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { projectHermesNativeCatalog } from "../../packages/gateway/src/ai-providers/hermes-native-catalog.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { PROVIDER_SETTINGS_NOW as now, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

function native(model: string, models: unknown[] = ["gpt-5.6-sol"]) {
  return normalizeHermesRuntimeSnapshot({ observedAt: +now, status: {}, options: {
    provider: "openai-codex", model, providers: [{ slug: "openai-codex",
      authenticated: true, is_user_defined: false, models }],
  } });
}

it("does not invent a Codex model from the previous provider's selection during login", () => {
  const snapshot = native("anthropic/claude-opus-4.6");
  expect(snapshot.providers[0]?.models.map(model => model.id)).toEqual(["gpt-5.6-sol"]);
  expect(snapshot.messaging.configured).toBe(false);
  expect(snapshot.runtime.options[0]?.nativeRouteObservation).toBeUndefined();
  expect(projectHermesNativeCatalog(snapshot, now).profiles).toEqual([]);
});

it("preserves provider-owned model paths when the native provider actually advertises them", () => {
  const model = "vendor/valid-model";
  const snapshot = native(model, [model]);
  expect(snapshot.messaging).toMatchObject({ configured: true, model });
  expect(projectHermesNativeCatalog(snapshot, now).profiles[0]?.defaultModelId).toBe(`openai-codex:${model}`);
});

it("preserves an advertised selected model beyond the bounded inventory slice", () => {
  const model = "gpt-5.6-sol";
  const snapshot = native(model, [...Array.from({ length: 128 }, (_, index) => `model-${index}`), model]);
  expect(snapshot.providers[0]?.models).toHaveLength(128);
  expect(snapshot.providers[0]?.models[0]?.id).toBe(model);
  expect(snapshot.messaging).toMatchObject({ configured: true, model });
});

it.each([
  { label: "empty", model: "gpt-5.6-sol", models: [] },
  { label: "invalid", model: "gpt-5.6-sol", models: [null, {}, " "] },
  { label: "excluded", model: "gpt-5.6-pro", models: ["gpt-5.6-pro"] },
])("does not promote a selection from $label Codex inventory", ({ model, models }) => {
  const snapshot = native(model, models);
  expect(snapshot.providers[0]?.models).toEqual([]);
  expect(snapshot.messaging.configured).toBe(false);
  expect(snapshot.runtime.options[0]?.nativeRouteObservation).toBeUndefined();
  expect(projectHermesNativeCatalog(snapshot, now).profiles).toEqual([]);
});

it("waits for a coherent native selection before binding the generated Hermes default", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "hermes-provider-switch-"));
  const canonical = providerSettingsCanonicalFixture();
  canonical.drivers.push({ id: "hermes", displayName: "Hermes", kind: "cli",
    installState: "installed", health: "degraded", capabilities: ["tools"], setupActions: [] });
  const store = new ProviderSettingsStore({ homePath, now: () => now,
    providerSnapshotReader: { getSnapshot: async () => canonical } });
  try {
    canonical.nativeHarnessCatalog = projectHermesNativeCatalog(native("anthropic/claude-opus-4.6"), now);
    const switching = await store.getSnapshot();
    expect(switching.harnesses.find(harness => harness.harness === "hermes")?.enabled).toBe(false);
    expect(switching.modelProviders.find(provider => provider.id === "openai-codex")?.models ?? [])
      .not.toContainEqual(expect.objectContaining({ id: "openai-codex:anthropic/claude-opus-4.6" }));
    canonical.nativeHarnessCatalog = projectHermesNativeCatalog(native("gpt-5.6-sol"), now);
    const connected = await store.getSnapshot({ refresh: true });
    expect(connected.harnesses.find(harness => harness.harness === "hermes")).toMatchObject({
      enabled: true, accessSourceId: "harness_hermes_openai-codex",
      route: { providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" },
    });
  } finally { await rm(homePath, { recursive: true, force: true }); }
});

it("retains an owner's saved Off through an incoherent provider switch and store restart", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "hermes-provider-switch-off-"));
  const canonical = providerSettingsCanonicalFixture();
  canonical.drivers.push({ id: "hermes", displayName: "Hermes", kind: "cli",
    installState: "installed", health: "degraded", capabilities: ["tools"], setupActions: [] });
  const options = { homePath, now: () => now,
    providerSnapshotReader: { getSnapshot: async () => canonical }, runtimeCoordinator: {
      supportedActions: ["set_harness_enabled" as const], supportedHarnessKinds: ["hermes" as const],
      isRecoveryReady: () => true, reconcilePending: async () => undefined,
      applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined,
    } };
  try {
    canonical.nativeHarnessCatalog = projectHermesNativeCatalog(native("gpt-5.6-sol"), now);
    const store = new ProviderSettingsStore(options);
    const connected = await store.getSnapshot();
    await store.mutate({ type: "set_harness_enabled", harnessInstanceId: "harness_hermes", enabled: false,
      expectedRevision: connected.revision, idempotencyKey: "provider-switch-off" });
    canonical.nativeHarnessCatalog = projectHermesNativeCatalog(native("anthropic/claude-opus-4.6"), now);
    expect((await store.getSnapshot({ refresh: true })).harnesses.find(harness => harness.harness === "hermes"))
      .toMatchObject({ enabled: false, configuredEnabled: false });
    canonical.nativeHarnessCatalog = projectHermesNativeCatalog(native("gpt-5.6-sol"), now);
    const restarted = await new ProviderSettingsStore(options).getSnapshot({ refresh: true });
    expect(restarted.harnesses.find(harness => harness.harness === "hermes")).toMatchObject({
      enabled: false, configuredEnabled: false, accessSourceId: "harness_hermes_openai-codex",
      route: { providerId: "openai-codex", modelId: "openai-codex:gpt-5.6-sol" },
    });
  } finally { await rm(homePath, { recursive: true, force: true }); }
});
