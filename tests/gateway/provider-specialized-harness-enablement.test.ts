import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentProviderSummary, type ProviderSettingsMutation } from "@matrix-os/contracts";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createCodexHarnessAdmission } from "../../packages/gateway/src/coding-agents/codex-harness-admission.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture, providerReady } from "./provider-settings-test-support.js";

describe("specialized harness enablement", () => {
  let homePath: string;
  afterEach(async () => { if (homePath) await rm(homePath, { recursive: true, force: true }); });

  async function setup() {
    homePath = await mkdtemp(join(tmpdir(), "specialized-harness-enablement-"));
    const canonical = providerSettingsCanonicalFixture();
    canonical.active = { providerInstanceId: "kernel_owner", accessSourceId: "owner_anthropic_profile", modelId: "claude-opus-5" };
    canonical.drivers.push({ ...canonical.drivers[1]!, id: "codex", displayName: "Codex" });
    canonical.accessSources.push({ ...canonical.accessSources[1]!, id: "owner_openai_profile", vendor: "openai", eligibleModelIds: ["gpt-test"] });
    canonical.models.push({ ...canonical.models[0]!, id: "gpt-test", vendor: "openai", displayName: "Test model", eligibleAccessSourceIds: ["owner_openai_profile"], dataPolicies: [{ accessSourceId: "owner_openai_profile", route: "owner_direct", disclosureKey: "owner-openai" }] });
    canonical.accounts.push({ ...canonical.accounts[0]!, id: "owner_openai", vendor: "openai" });
    canonical.instances.push({ ...canonical.instances[1]!, id: "codex_owner", driverId: "codex", vendor: "openai", accountId: "owner_openai", accessSourceId: "owner_openai_profile", modelIds: ["gpt-test"], defaultModelId: "gpt-test", readiness: { ...providerReady } });
    const update = vi.fn(async () => { throw new Error("specialized switches must not change the system runtime"); });
    const runtimeSource = vi.fn(async () => { throw new Error("specialized switches must not inspect the system runtime"); });
    const runtime = createProviderGenericHarnessCoordinator({ homePath, runtimeController: { update }, runtimeSource, enabledCodingHarnesses: [] });
    const makeStore = () => new ProviderSettingsStore({ homePath, providerSnapshotReader: { getSnapshot: async () => canonical }, runtimeCoordinator: runtime, now: () => PROVIDER_SETTINGS_NOW });
    const store = makeStore();
    return { canonical, runtime, update, runtimeSource, store, makeStore };
  }

  it.each(["claude", "codex"] as const)("persists %s off/on independently while preserving exact native account, files and fixed route", async (kind) => {
    const { store, makeStore, runtime, update, runtimeSource } = await setup();
    const initial = await store.getSnapshot();
    expect(initial.configurationHarnessKinds).toContain(kind);
    const selected = initial.harnesses.find((h) => h.harness === kind)!;
    const other = initial.harnesses.find((h) => h.harness !== kind)!;
    const credentialPath = join(homePath, kind === "claude" ? ".claude/.credentials.json" : ".codex/auth.json");
    const historyPath = join(homePath, "conversations/synthetic-history.json");
    for (const path of [credentialPath, historyPath]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "synthetic retained fixture");
    }
    await store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: initial.revision, idempotencyKey: "specialized_off", enabled: false });
    const persisted = await makeStore().getSnapshot();
    expect(persisted.harnesses.find((h) => h.id === selected.id)).toMatchObject({ configuredEnabled: false, enabled: false, selectedAccountId: selected.selectedAccountId, accessSourceId: selected.accessSourceId, route: selected.route });
    expect(persisted.harnesses.find((h) => h.id === other.id)?.configuredEnabled).toBe(other.configuredEnabled);
    const admission = createCodexHarnessAdmission({ homePath });
    await expect(admission.isProviderEnabled(kind)).resolves.toBe(false);
    const on = await store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: persisted.revision, idempotencyKey: "specialized_on", enabled: true });
    expect(on.snapshot.harnesses.find((h) => h.id === selected.id)).toMatchObject({ configuredEnabled: true, selectedAccountId: selected.selectedAccountId, accessSourceId: selected.accessSourceId, route: selected.route });
    await expect(admission.isProviderEnabled(kind)).resolves.toBe(true);
    for (const path of [credentialPath, historyPath]) expect(await readFile(path, "utf8")).toBe("synthetic retained fixture");
    expect(update).not.toHaveBeenCalled();
    expect(runtimeSource).not.toHaveBeenCalled();
    expect(runtime.supportedHarnessKinds).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it.each(["claude", "codex"] as const)("rejects generic metadata, removal and route mutations for %s", async (kind) => {
    const { store } = await setup();
    const initial = await store.getSnapshot();
    const selected = initial.harnesses.find((h) => h.harness === kind)!;
    const base = { harnessInstanceId: selected.id, expectedRevision: initial.revision, idempotencyKey: "specialized_rejected" };
    const mutations: ProviderSettingsMutation[] = [
      { ...base, type: "update_harness", displayName: "Unrelated rename" },
      { ...base, type: "remove_harness" },
      { ...base, type: "set_route", accountId: selected.selectedAccountId, accessSourceId: selected.accessSourceId!, route: { ...selected.route, kind: "configurable" } },
    ];
    for (const mutation of mutations) await expect(store.mutate(mutation)).rejects.toBeDefined();
    expect((await store.getSnapshot()).harnesses.find((h) => h.id === selected.id)).toEqual(selected);
  });

  it.each(["claude", "codex"] as const)("allows %s off after runtime loss and refuses on until its exact driver is installed", async (kind) => {
    const { store, canonical } = await setup();
    const initial = await store.getSnapshot();
    const selected = initial.harnesses.find((h) => h.harness === kind)!;
    const driver = canonical.drivers.find((d) => d.id === (kind === "claude" ? "claude_code" : "codex"))!;
    driver.installState = "missing";
    const off = await store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: initial.revision, idempotencyKey: "missing_driver_off", enabled: false });
    expect(off.snapshot.harnesses.find((h) => h.id === selected.id)).toMatchObject({ configuredEnabled: false, installState: "missing" });
    await expect(store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: off.snapshot.revision, idempotencyKey: "missing_driver_on", enabled: true })).rejects.toMatchObject({ code: "invalid_request" });
    expect((await store.getSnapshot()).revision).toBe(off.snapshot.revision);
  });

  it.each(["claude", "codex"] as const)("does not promote %s authentication or access readiness when recording enablement", async (kind) => {
    const { store, canonical } = await setup();
    const initial = await store.getSnapshot();
    const selected = initial.harnesses.find((h) => h.harness === kind)!;
    const off = await store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: initial.revision, idempotencyKey: "unknown_access_off", enabled: false });
    canonical.active = { providerInstanceId: null, accessSourceId: null, modelId: null };
    const source = canonical.accessSources.find((s) => s.id === selected.accessSourceId)!;
    Object.assign(source, { state: "unknown", action: "retry", safeReason: "unknown" });
    for (const instance of canonical.instances.filter((i) => i.accessSourceId === source.id)) {
      instance.readiness = { ...instance.readiness, state: "unknown", action: "retry", safeReason: "unknown" };
      instance.defaultModelId = null;
    }
    const on = await store.mutate({ type: "set_harness_enabled", harnessInstanceId: selected.id, expectedRevision: off.snapshot.revision, idempotencyKey: "unknown_access_on", enabled: true });
    expect(on.snapshot.harnesses.find((h) => h.id === selected.id)).toMatchObject({ configuredEnabled: true, enabled: true, authState: "unknown", selectedAccountId: selected.selectedAccountId, accessSourceId: selected.accessSourceId, route: selected.route });
    expect(source.state).toBe("unknown");
  });

  it.each(["claude", "codex"] as const)("fails %s canonical Chat closed if persisted Settings cannot be read", async (kind) => {
    const summary: AgentProviderSummary = { id: kind, displayName: kind, kind, availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", defaultModel: "test-model", setupActions: [] };
    const catalog = createChatProviderCatalogService({ codingProviders: { listProviders: async () => [summary], invalidate() {} }, harnessSettingsSource: { getSnapshot: async () => { throw new Error("synthetic settings read failure"); } } });
    const result = await catalog.getCatalog({ userId: "synthetic_owner", source: "jwt" });
    expect(result.instances.find((i) => i.driverKind === (kind === "claude" ? "claude_code" : "codex"))).toMatchObject({ availability: "unavailable", unavailabilityReason: "settings_unavailable" });
  });

  it.each(["claude", "codex"] as const)("projects saved-off %s into canonical Chat admission even with authenticated native inventory", async (kind) => {
    const { store } = await setup();
    const snapshot = await store.getSnapshot();
    const selected = snapshot.harnesses.find((h) => h.harness === kind)!;
    // Supply saved owner intent directly, before the mutation path is implemented.
    selected.configuredEnabled = false;
    selected.enabled = false;
    const summary: AgentProviderSummary = { id: kind, displayName: kind, kind, availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", defaultModel: "test-model", setupActions: [] };
    const catalog = createChatProviderCatalogService({ codingProviders: { listProviders: async () => [summary], invalidate() {} }, harnessSettingsSource: { getSnapshot: async () => snapshot } });
    const result = await catalog.getCatalog({ userId: "synthetic_owner", source: "jwt" });
    expect(result.instances.find((i) => i.driverKind === (kind === "claude" ? "claude_code" : "codex"))).toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings" });
  });
});
