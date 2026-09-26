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
afterEach(() => vi.useRealTimers());
describe("canonical native model scope", () => {
  it("keeps disjoint Pi/OpenCode inventories under the same provider separate through Settings and Hono", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "native-shared-provider-"));
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
