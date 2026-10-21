import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiProviderSnapshotV3Schema, type ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

function nativeCodex() {
  const base = providerSettingsCanonicalFixture();
  const unavailable = { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const };
  return AiProviderSnapshotV3Schema.parse({
    ...base,
    accounts: [...base.accounts, { ...base.accounts[0], id: "owner_codex", vendor: "openai", ...unavailable }],
    accessSources: [...base.accessSources, { ...base.accessSources[1], id: "owner_openai_profile", vendor: "openai", eligibleModelIds: ["test-codex-model"], ...unavailable,
      localObservation: { state: "present_unverified", checkedAt: PROVIDER_SETTINGS_NOW.toISOString(), staleAfter: new Date(PROVIDER_SETTINGS_NOW.getTime() + 5000).toISOString() } }],
    models: [...base.models, { ...base.models[0], id: "test-codex-model", vendor: "openai", eligibleAccessSourceIds: ["owner_openai_profile"], dataPolicies: [{ accessSourceId: "owner_openai_profile", route: "owner_direct", disclosureKey: "owner-openai" }] }],
    drivers: [...base.drivers, { ...base.drivers[1], id: "codex" }],
    instances: [...base.instances, { ...base.instances[1], id: "codex_owner_openai_profile", driverId: "codex", vendor: "openai", accountId: "owner_codex", accessSourceId: "owner_openai_profile", readiness: unavailable, modelIds: ["test-codex-model"], defaultModelId: null }],
  });
}

describe("Settings Disconnect preserves native account credentials", () => {
  it("disconnects only the exact Codex agent, survives refresh/restart, and supports deliberate reconnect", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "settings-disconnect-"));
    try {
      const canonical = nativeCodex();
      const update = vi.fn();
      const runtime = normalizeHermesRuntimeSnapshot({ observedAt: +PROVIDER_SETTINGS_NOW, status: {}, options: { providers: [] } });
      const coordinator = () => createProviderGenericHarnessCoordinator({ homePath,
        runtimeController: { update }, runtimeSource: async () => runtime, enabledCodingHarnesses: [] });
      const lifecycle = { supportedActions: () => [], logout: vi.fn(), remove: vi.fn() };
      const makeStore = () => new ProviderSettingsStore({ homePath, now: () => PROVIDER_SETTINGS_NOW,
        providerSnapshotReader: { getSnapshot: async () => structuredClone(canonical) },
        runtimeCoordinator: coordinator(), accountLifecycle: lifecycle });
      await mkdir(join(homePath, ".codex"), { recursive: true });
      const authPath = join(homePath, ".codex/auth.json");
      const fakeAuth = JSON.stringify({ syntheticCredential: "fixture-only" });
      await writeFile(authPath, fakeAuth);
      const store = makeStore();
      const before = await store.getSnapshot();
      const codex = before.harnesses.find(row => row.harness === "codex")!;
      expect(codex).toBeDefined();
      expect(before.supportedActions).toContain("set_harness_enabled");
      const mutation = { type: "set_harness_enabled" as const, harnessInstanceId: codex.id,
        enabled: false, expectedRevision: before.revision, idempotencyKey: "disconnect_codex_only" };
      const denied = createProviderSettingsRoutes({ store, getPrincipal: () => null });
      const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mutation) };
      expect((await denied.request("/provider-settings/actions?includeCapabilities=true", request)).status).toBe(401);
      expect((await store.getSnapshot()).revision).toBe(before.revision);
      const routes = createProviderSettingsRoutes({ store, getPrincipal: () => ({ userId: "fixture_owner" }) });
      const response = await routes.request("/provider-settings/actions?includeCapabilities=true", request);
      expect(response.status).toBe(200);
      const disconnected = await response.json() as { snapshot: ProviderSettingsSnapshot };
      expect(disconnected.snapshot.harnesses.find(row => row.id === codex.id)).toMatchObject({ enabled: false, configuredEnabled: false });
      for (const other of before.harnesses.filter(row => row.id !== codex.id)) {
        expect(disconnected.snapshot.harnesses.find(row => row.id === other.id)).toMatchObject({ enabled: other.enabled, configuredEnabled: other.configuredEnabled, route: other.route, accessSourceId: other.accessSourceId });
      }
      await expect(store.mutate({ ...mutation, harnessInstanceId: "missing_exact_agent", expectedRevision: disconnected.snapshot.revision,
        idempotencyKey: "missing_agent_disconnect" })).rejects.toMatchObject({ code: "not_found" });
      expect(await readFile(authPath, "utf8")).toBe(fakeAuth);
      expect(lifecycle.logout).not.toHaveBeenCalled();
      expect(lifecycle.remove).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      const restarted = makeStore();
      const persisted = await restarted.getSnapshot({ refresh: true });
      expect(persisted.harnesses.find(row => row.id === codex.id)).toMatchObject({ configuredEnabled: false });
      expect((await restarted.mutate(mutation)).snapshot.revision).toBe(disconnected.snapshot.revision);
      await expect(restarted.mutate({ ...mutation, idempotencyKey: "stale_disconnect" })).rejects.toMatchObject({ code: "revision_conflict" });
      const connected = await restarted.mutate({ ...mutation, enabled: true, expectedRevision: persisted.revision, idempotencyKey: "explicit_reconnect" });
      expect(connected.snapshot.harnesses.find(row => row.id === codex.id)).toMatchObject({ configuredEnabled: true });
      expect(await readFile(authPath, "utf8")).toBe(fakeAuth);
      expect(update).not.toHaveBeenCalled();
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });
});
