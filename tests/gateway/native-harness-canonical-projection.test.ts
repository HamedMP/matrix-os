import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createGenericHarnessModelCatalogReader } from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";

const now = new Date("2026-09-26T00:00:00Z");
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function isolatedHome(prefix: string) {
  const homePath = await mkdtemp(join(tmpdir(), prefix));
  vi.stubEnv("XDG_CONFIG_HOME", join(homePath, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(homePath, ".local/share"));
  return homePath;
}
describe("canonical native model scope", () => {
  it("isolates an invalid OpenCode profile instead of poisoning valid Pi", async () => {
    const source = (harness: "pi" | "opencode", model: string) => ({ id: `harness_${harness}_native`, kind: "harness_profile" as const,
      harness, fundingKind: "owner_account" as const, providerId: "native", accountId: null, displayName: harness,
      eligibleModelIds: [model], readiness: { state: "unknown" as const, checkedAt: null, staleAfter: null, action: "retry" as const, safeReason: "unknown" as const },
      localObservation: { state: "unknown" as const, checkedAt: null, staleAfter: null },
      usage: { kind: "unavailable" as const, authority: "unavailable" as const, state: "not_applicable" as const, scope: "access_source" as const, reason: "provider_does_not_report" as const, asOf: null } });
    const read = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => ({
      providers: [{ id: "native", displayName: "Native", models: [{ id: "native:pi", displayName: "Pi", enabled: true }, { id: "wrong:open", displayName: "Open", enabled: true }] }],
      accessSources: [source("pi", "native:pi"), source("opencode", "wrong:open")], failures: [],
    }) });
    expect(await read(false)).toMatchObject({ profiles: [{ harness: "pi", models: [{ id: "native:pi" }] }], failures: ["opencode"] });
  });
  it("preserves exact OpenCode provider case without rejecting valid Pi through producer and Settings", async () => {
    const homePath = await isolatedHome("native-case-provider-");
    for (const dir of [".pi/agent", ".config/opencode", ".local/share/opencode"]) await mkdir(join(homePath, dir), { recursive: true });
    await writeFile(join(homePath, ".pi/agent/settings.json"), '{"defaultProvider":"native","defaultModel":"pi-model"}');
    await writeFile(join(homePath, ".pi/agent/auth.json"), '{"native":{"type":"api_key","key":"fixture"}}');
    await writeFile(join(homePath, ".config/opencode/opencode.json"), '{"model":"Foo/model"}');
    await writeFile(join(homePath, ".local/share/opencode/auth.json"), '{"Foo":{"type":"api","key":"fixture"}}');
    const reader = createGenericHarnessModelCatalogReader({ homePath, enabledHarnesses: ["pi", "opencode"], now: () => now,
      run: async (command) => ({ stdout: command.endsWith("pi") ? "provider model\nnative pi-model" : "Foo/model", stderr: "" }) });
    const producer = new AiProviderService({ homePath, env: {}, now: () => now, nativeHarnessCatalogReader: reader,
      driverInventory: async () => ["pi", "opencode"].map((id) => ({ id, displayName: id, kind: "cli", installState: "installed", health: "unknown", capabilities: ["tools"], setupActions: [] })) });
    try {
      const canonical = await producer.getSnapshot();
      expect(canonical.nativeHarnessCatalog?.failures).toEqual([]);
      expect(canonical.nativeHarnessCatalog?.profiles.find((profile) => profile.harness === "opencode"))
        .toMatchObject({ providerId: "Foo", defaultModelId: "Foo:model", models: [{ id: "Foo:model" }] });
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer });
      const snapshot = await store.getSnapshot();
      expect(snapshot.harnesses.find((row) => row.harness === "pi")).toMatchObject({ enabled: true, route: { modelId: "native:pi-model" } });
      expect(snapshot.harnesses.find((row) => row.harness === "opencode")).toMatchObject({ enabled: true, route: { providerId: "Foo", modelId: "Foo:model" } });
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("keeps disjoint Pi/OpenCode inventories under the same provider separate through Settings and Hono", async () => {
    const homePath = await isolatedHome("native-shared-provider-");
    for (const dir of [".pi/agent", ".config/opencode", ".local/share/opencode"]) await mkdir(join(homePath, dir), { recursive: true });
    await writeFile(join(homePath, ".pi/agent/settings.json"), '{"defaultProvider":"shared","defaultModel":"pi-only"}');
    await writeFile(join(homePath, ".pi/agent/auth.json"), '{"shared":{"type":"api_key","key":"fixture"}}');
    await writeFile(join(homePath, ".config/opencode/opencode.json"), '{"model":"shared/open-only"}');
    await writeFile(join(homePath, ".local/share/opencode/auth.json"), '{"shared":{"type":"api","key":"fixture"}}');
    const reader = createGenericHarnessModelCatalogReader({ homePath, enabledHarnesses: ["pi", "opencode"], now: () => now,
      run: async (command) => ({ stdout: command.endsWith("pi") ? "provider model\nshared pi-only" : "shared/open-only", stderr: "" }) });
    const producer = new AiProviderService({ homePath, env: {}, now: () => now, nativeHarnessCatalogReader: reader,
      driverInventory: async () => ["pi", "opencode"].map((id) => ({ id, displayName: id, kind: "cli", installState: "installed", health: "unknown", capabilities: ["tools"], setupActions: [] })) });
    try {
      const canonical = await producer.getSnapshot();
      expect(canonical.nativeHarnessCatalog?.profiles.find((profile) => profile.harness === "pi")?.models.map((model) => model.id)).toEqual(["shared:pi-only"]);
      expect(canonical.nativeHarnessCatalog?.profiles.find((profile) => profile.harness === "opencode")?.models.map((model) => model.id)).toEqual(["shared:open-only"]);
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer,
        runtimeCoordinator: { supportedActions: ["set_route"], supportedHarnessKinds: ["pi", "opencode"], isRecoveryReady: () => true,
          reconcilePending: async () => undefined, applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined } });
      const snapshot = await store.getSnapshot();
      expect(snapshot.accessSources.find((source) => source.harness === "pi")?.eligibleModelIds).toEqual(["shared:pi-only"]);
      const app = new Hono(); app.route("/api/ai", createProviderSettingsRoutes({ store, getPrincipal: () => ({ userId: "owner" }) }));
      const response = await app.request("/api/ai/provider-settings/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        type: "set_route", harnessInstanceId: "harness_pi", expectedRevision: snapshot.revision, idempotencyKey: "cross_harness_model",
        accessSourceId: "harness_pi_shared", accountId: null, route: { kind: "configurable", providerId: "shared", modelId: "shared:open-only" }, enableHarness: true,
      }) });
      expect(response.status).toBe(400);
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
  it("does not spawn another unfinished canonical observation after a timeout", async () => {
    vi.useFakeTimers();
    const getCatalog = vi.fn(() => new Promise<never>(() => undefined));
    const read = createCanonicalNativeHarnessCatalogReader({ getCatalog });
    const first = read(false);
    await vi.advanceTimersByTimeAsync(6501); expect((await first).failures).toEqual(["pi", "opencode"]);
    const second = read(true);
    await vi.advanceTimersByTimeAsync(6501); await second;
    expect(getCatalog).toHaveBeenCalledTimes(1);
  });
});
