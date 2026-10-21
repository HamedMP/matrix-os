import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { projectHermesNativeCatalog } from "../../packages/gateway/src/ai-providers/hermes-native-catalog.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { PROVIDER_SETTINGS_NOW as now, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

it("persists Off for the last system harness without installing or switching runtimes, blocking Chat until explicit On", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "last-system-harness-off-"));
  const runtime = normalizeHermesRuntimeSnapshot({ observedAt: +now, status: {}, options: {
    provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex",
      authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }],
  } });
  const canonical = providerSettingsCanonicalFixture();
  canonical.drivers.push({ id: "hermes", displayName: "Hermes", kind: "cli",
    installState: "installed", health: "degraded", capabilities: ["tools"], setupActions: [] });
  canonical.nativeHarnessCatalog = projectHermesNativeCatalog(runtime, now);
  const update = vi.fn(async () => ({ revision: 4, runtime: "hermes" as const,
    selection: { runtime: "hermes" as const, provider: "openai-codex", model: "gpt-5.6-sol", configured: true } }));
  const makeCoordinator = () => createProviderGenericHarnessCoordinator({ homePath,
    runtimeController: { update }, runtimeSource: async () => runtime, enabledCodingHarnesses: [] });
  const makeStore = () => new ProviderSettingsStore({ homePath, now: () => now,
    providerSnapshotReader: { getSnapshot: async () => canonical }, runtimeCoordinator: makeCoordinator() });
  try {
    await mkdir(join(homePath, "system"), { recursive: true });
    const runtimeConfig = JSON.stringify({ agent: { messagingRuntime: "hermes", revision: 4 } });
    await writeFile(join(homePath, "system/config.json"), runtimeConfig);
    const store = makeStore();
    const initial = await store.getSnapshot();
    const harness = initial.harnesses.find(harness => harness.harness === "hermes")!;
    expect(harness.enabled).toBe(true);
    expect(initial.harnesses.some(harness => harness.harness === "openclaw" && harness.enabled)).toBe(false);
    const mutation = { type: "set_harness_enabled" as const, harnessInstanceId: harness.id,
      enabled: false, expectedRevision: initial.revision, idempotencyKey: "last-hermes-off" };
    const disabled = await store.mutate(mutation);
    expect(disabled.snapshot.harnesses.find(harness => harness.harness === "hermes")).toMatchObject({
      enabled: false, configuredEnabled: false,
      route: harness.route, configuredAccessSourceId: harness.accessSourceId,
    });
    expect(update).not.toHaveBeenCalled();
    expect(await readFile(join(homePath, "system/config.json"), "utf8")).toBe(runtimeConfig);
    expect(runtime.messaging).toMatchObject({ configured: true, provider: "openai-codex", model: "gpt-5.6-sol" });
    const restarted = makeStore();
    const persisted = await restarted.getSnapshot({ refresh: true });
    expect(persisted.harnesses.find(harness => harness.harness === "hermes")).toMatchObject({
      enabled: false, configuredEnabled: false,
    });
    expect((await restarted.mutate(mutation)).snapshot.revision).toBe(disabled.snapshot.revision);
    const catalog = createChatProviderCatalogService({ now: () => now,
      codingProviders: { listProviders: async () => [], invalidate: () => {} },
      agentRuntimeSource: async () => runtime,
      harnessSettingsSource: restarted, executableDriverKinds: ["hermes"],
    });
    const principal = { userId: "test_owner", source: "jwt" as const };
    expect((await catalog.getCatalog(principal)).instances.find(instance => instance.driverKind === "hermes"))
      .toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings", models: [] });
    await restarted.mutate({ ...mutation, enabled: true,
      expectedRevision: persisted.revision, idempotencyKey: "last-hermes-on" });
    expect((await catalog.getCatalog(principal)).instances.find(instance => instance.driverKind === "hermes"))
      .toMatchObject({ availability: "available", defaultSelection: { model: "openai-codex:gpt-5.6-sol" } });
    expect(update).not.toHaveBeenCalled();
    expect(await readFile(join(homePath, "system/config.json"), "utf8")).toBe(runtimeConfig);
  } finally { await rm(homePath, { recursive: true, force: true }); }
});
