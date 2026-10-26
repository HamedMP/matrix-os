import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiNativeHarnessCatalogSchema, CanonicalProviderCatalogSchema, ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createChatProviderRoutes } from "../../packages/gateway/src/chat/provider-routes.js";
import { PROVIDER_SETTINGS_NOW as now, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

describe("large merged provider catalogs", () => {
  let homePath: string;
  let fixtureRoot: string;
  let store: ProviderSettingsStore;
  const canonical = providerSettingsCanonicalFixture();
  const model = (id: string) => ({ id: `openrouter:${id}`, displayName: id, enabled: true });
  const observation = { state: "present_unverified", checkedAt: now.toISOString(), staleAfter: "2026-08-30T10:05:00.000Z" };
  const saved = {
    schemaVersion: 1, revision: 1,
    harnesses: [
      { id: "harness_hermes", driverId: "hermes", harness: "hermes", displayName: "Hermes", accentColor: null,
        enabled: true, enablementOrigin: "owner_configuration", selectedAccountId: null, accessSourceId: "harness_hermes_openrouter",
        route: { kind: "configurable", providerId: "openrouter", modelId: "openrouter:hermes-10" } },
      { id: "harness_opencode", driverId: "opencode", harness: "opencode", displayName: "OpenCode", accentColor: null,
        enabled: false, enablementOrigin: "owner_configuration", selectedAccountId: null, accessSourceId: "harness_opencode_openrouter",
        route: { kind: "configurable", providerId: "openrouter", modelId: "openrouter:code-255" } },
    ], accountProfiles: [], gatewayPolicy: null, receipts: [],
  };

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "large-provider-catalog-"));
    homePath = join(fixtureRoot, "home");
    canonical.nativeHarnessCatalog = AiNativeHarnessCatalogSchema.parse({ profiles: [
      { harness: "hermes", providerId: "openrouter", providerDisplayName: "OpenRouter",
        models: Array.from({ length: 11 }, (_, i) => model(`hermes-${i}`)), defaultModelId: "openrouter:hermes-10", localObservation: observation },
      { harness: "opencode", providerId: "openrouter", providerDisplayName: "OpenRouter",
        models: Array.from({ length: 256 }, (_, i) => model(`code-${i}`)), defaultModelId: "openrouter:code-255", localObservation: observation },
    ], failures: [] });
    canonical.drivers = [...canonical.drivers.filter(d => d.id !== "hermes" && d.id !== "opencode"),
      ...(["hermes", "opencode"] as const).map(id => ({ id, displayName: id, kind: "cli" as const, installState: "installed" as const,
        health: "ready" as const, capabilities: ["tools" as const], setupActions: [] }))];
    await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
    await writeFile(join(homePath, "system/ai-providers/settings.json"), JSON.stringify(saved), { mode: 0o600 });
    store = new ProviderSettingsStore({ homePath, privateRootPath: join(fixtureRoot, "private"), now: () => now,
      providerSnapshotReader: { getSnapshot: async () => canonical } });
  });
  afterEach(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

  it("serves Settings with 267 discovered models while retaining selected routes and consistent eligibility", async () => {
    const app = new Hono();
    app.route("/api/ai", createProviderSettingsRoutes({ store, getPrincipal: () => ({ userId: "owner", source: "jwt" }) }));
    const response = await app.request("/api/ai/provider-settings");
    expect(response.status).toBe(200);
    const snapshot = ProviderSettingsSnapshotSchema.parse(await response.json());
    const provider = snapshot.modelProviders.find(p => p.id === "openrouter")!;
    expect(provider.models).toHaveLength(256);
    expect(provider.models.map(m => m.id)).toEqual(expect.arrayContaining(["openrouter:hermes-10", "openrouter:code-255"]));
    for (const source of snapshot.accessSources.filter(s => s.providerId === "openrouter")) {
      expect(source.eligibleModelIds.every(id => provider.models.some(m => m.id === id))).toBe(true);
    }
    expect(snapshot.harnesses.find(h => h.id === "harness_opencode")).toMatchObject({ enabled: false,
      route: { modelId: "openrouter:code-255" } });
    const persisted = JSON.parse(await readFile(join(homePath, "system/ai-providers/settings.json"), "utf8"));
    expect(persisted.harnesses.find((h: { id: string }) => h.id === "harness_opencode")).toEqual(saved.harnesses[1]);
  });

  it("serves the Chat catalog through the real Settings store instead of rejecting the whole picker", async () => {
    const catalog = createChatProviderCatalogService({
      now: () => now,
      codingProviders: { listProviders: async () => [], invalidate: () => undefined },
      harnessSettingsSource: store, aiProviderSource: { getSnapshot: async () => canonical },
      agentRuntimeSource: async () => ({ runtime: { selected: "hermes", transition: null, options: [{
        id: "hermes", displayName: "Hermes", installState: "installed", health: "healthy", selectionState: "active",
        configured: true, capabilities: ["provider_catalog", "model_selection", "authentication"],
      }] }, providers: [{ id: "openrouter", displayName: "OpenRouter", runtime: "hermes", scopes: ["messaging"],
        authKind: "api_key", supportedAuthKinds: ["api_key"], authStatus: { state: "ready", authenticated: true, action: "none" },
        models: Array.from({ length: 11 }, (_, i) => ({ id: `hermes-${i}`, displayName: `Hermes ${i}`, available: true,
          capabilities: ["tools"], efforts: [] })),
      }], messaging: { runtime: "hermes", configured: true, provider: "openrouter", model: "hermes-10" } }),
    });
    const app = createChatProviderRoutes({ catalog, getPrincipal: () => ({ userId: "owner", source: "jwt" }) });
    const response = await app.request("/api/chat-providers");
    expect(response.status).toBe(200);
    const snapshot = CanonicalProviderCatalogSchema.parse(await response.json());
    const hermes = snapshot.instances.find(instance => instance.id === "hermes_default");
    expect(hermes).toMatchObject({ availability: "available",
      defaultSelection: { instanceId: "hermes_default", model: "openrouter:hermes-10" } });
    expect(hermes!.models).toContainEqual(expect.objectContaining({ id: "openrouter:hermes-10", availability: "available" }));
  });
});
