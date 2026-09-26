import { createCodingHarnessCredentialResolver } from "../../packages/gateway/src/coding-agents/harness-credentials.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { createProviderDriverInventoryReader } from "../../packages/gateway/src/ai-providers/provider-driver-inventory.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AiProviderSnapshotV3Schema, type AgentProviderSummary } from "@matrix-os/contracts";
import { createGenericHarnessModelCatalogReader } from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createCodexHarnessAdmission } from "../../packages/gateway/src/coding-agents/codex-harness-admission.js";
import { createCodingAgentRoutes } from "../../packages/gateway/src/coding-agents/routes.js";
import { createCodingAgentThreadStore, createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

const principal = { userId: "owner_user", source: "jwt" as const };
const kinds = ["pi", "opencode"] as const;
function homePathFor(homePath: string, kind: typeof kinds[number]) {
  return kind === "pi" ? join(homePath, ".pi/agent") : join(homePath, ".local/share/opencode");
}
function post(body: unknown): Request {
  return new Request("http://localhost/api/coding-agents/threads", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

async function fixture(kind: typeof kinds[number], reconcile: boolean, multipleProviders = false) {
  const homePath = await mkdtemp(join(tmpdir(), "generated-harness-default-"));
  const canonical = providerSettingsCanonicalFixture();
  {
    const directory = kind === "pi" ? join(homePath, ".pi/agent") : join(homePath, ".config/opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, kind === "pi" ? "settings.json" : "opencode.json"), JSON.stringify(
      kind === "pi" ? { defaultProvider: multipleProviders ? "z-working" : "native", defaultModel: multipleProviders ? "saved-model" : "working-model" }
        : { model: multipleProviders ? "z-working/saved-model" : "native/working-model" }));
  }
  const credentialDirectory = kind === "pi" ? join(homePath, ".pi/agent") : join(homePath, ".local/share/opencode");
  await mkdir(credentialDirectory, { recursive: true });
  await writeFile(join(credentialDirectory, "auth.json"), JSON.stringify({ [multipleProviders ? "z-working" : "native"]:
    kind === "pi" ? { type: "api_key", key: "dummy-local-fixture" } : { type: "api", key: "dummy-local-fixture" } }));
  const nativeCatalogMode = { fail: false };
  const nativeCatalog = createGenericHarnessModelCatalogReader({ homePath, enabledHarnesses: [kind], now: () => PROVIDER_SETTINGS_NOW,
    run: async () => { if (nativeCatalogMode.fail) throw new Error("Catalog unavailable");
      return { stdout: multipleProviders
        ? kind === "pi" ? "provider model context max-out thinking images\na-no-auth listed-model 200000 32000 yes no\nz-working saved-model 200000 32000 yes no" : "a-no-auth/listed-model\nz-working/saved-model"
        : kind === "pi" ? "provider model context max-out thinking images\nnative working-model 200000 32000 yes no" : "native/working-model", stderr: "" }; } });
  const readNative = createCanonicalNativeHarnessCatalogReader(nativeCatalog);
  const store = new ProviderSettingsStore({
    homePath, providerSnapshotReader: { getSnapshot: async ({ refresh } = {}) => AiProviderSnapshotV3Schema.parse({ ...canonical, nativeHarnessCatalog: await readNative(refresh ?? false) }) },
    now: () => PROVIDER_SETTINGS_NOW,
    runtimeCoordinator: { supportedActions: ["set_harness_enabled", "update_harness", "set_route", "select_access_source"], supportedHarnessKinds: [kind],
      isRecoveryReady: () => true, reconcilePending: async () => undefined,
      applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined },
  });
  if (reconcile) await store.getSnapshot();
  const readDrivers = createProviderDriverInventoryReader({
    detectAgentInstallations: async () => ({ agents: [{ id: kind, command: kind, displayName: kind, installState: "installed",
      installed: true, authState: "unknown", workspaceCompatibility: "not_applicable", errorCode: null }] }),
    runtimeSource: async () => ({ runtime: { selected: "hermes", transition: null, options: [] }, providers: [],
      messaging: { runtime: "hermes", provider: "anthropic", model: "claude-sonnet-5", configured: true } }),
  });
  canonical.drivers.push(...await readDrivers(AbortSignal.timeout(1000)));
  await store.getSnapshot();
  const provider = createFakeCodingAgentProvider({ providerId: kind });
  const startThread = vi.spyOn(provider, "startThread");
  const summary: AgentProviderSummary = {
    ...provider.getSummary!({ now: () => PROVIDER_SETTINGS_NOW }),
    id: kind, kind, availability: "available", installStatus: "installed", authStatus: "authenticated",
    supportedModes: ["default"], defaultMode: "default", defaultModel: "native:working-model", setupActions: [],
  };
  const catalogMode = { fail: false };
  const catalog = createChatProviderCatalogService({
    now: () => PROVIDER_SETTINGS_NOW,
    codingProviders: { listProviders: async () => [summary], invalidate: () => undefined },
    agentRuntimeSource: async () => { throw new Error("No system runtime in this fixture"); },
    harnessSettingsSource: store, executableDriverKinds: [kind], credentialedDriverKinds: [kind],
    codingModelCatalogSource: async () => {
      if (catalogMode.fail) throw new Error("Catalog unavailable");
      return ({
      models: [{ id: "native:working-model", displayName: "Working native model", capabilities: ["tools"], supportsVision: false, supportsToolUse: true }],
      options: [], defaultModel: "native:working-model",
    }); },
  });
  const threads = createCodingAgentThreadStore({
    homePath, providers: [provider], providerAdmission: createCodexHarnessAdmission({ homePath }),
    relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined },
  });
  const app = new Hono();
  app.route("/api/coding-agents", createCodingAgentRoutes({ threads, turns: threads, getPrincipal: () => principal }));
  return { homePath, nativeCatalog, readDrivers, store, catalog, app, threads, startThread, summary, catalogMode, nativeCatalogMode, canonical, cleanup: async () => {
    await threads.shutdownTurns();
    await rm(homePath, { recursive: true, force: true });
  } };
}

describe("generated Settings defaults preserve existing native coding routes", () => {
  it.each(kinds)("a transient %s discovery failure does not overwrite bound durable enablement", async (kind) => {
    const f = await fixture(kind, false);
    try {
      const before = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      const bound = before.harnesses.find((row: { harness: string }) => row.harness === kind);
      expect(bound.enabled).toBe(true);
      f.nativeCatalogMode.fail = true;
      const failed = await f.store.getSnapshot({ refresh: true });
      expect(failed.harnesses.find((row) => row.harness === kind)?.enabled).toBe(false);
      const after = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      expect(after.harnesses.find((row: { harness: string }) => row.harness === kind)).toEqual(bound);
      f.nativeCatalogMode.fail = false;
      // Admission reads durable permission, not an availability side effect from a prior GET.
      expect((await f.app.request(post({ providerId: kind, prompt: "Inspect", clientRequestId: `recovered_${kind}` }))).status).toBe(202);
      expect((await f.store.getSnapshot({ refresh: true })).harnesses.find((row) => row.harness === kind)?.enabled).toBe(true);
    } finally { await f.cleanup(); }
  });
  it.each(kinds)("enabled %s source selection requires fresh exact local observation", async (kind) => {
    const f = await fixture(kind, false);
    try {
      await writeFile(join(homePathFor(f.homePath, kind), "auth.json"), "{}");
      const snapshot = await f.store.getSnapshot();
      const row = snapshot.harnesses.find((entry) => entry.harness === kind)!;
      await expect(f.store.mutate({ type: "select_access_source", expectedRevision: snapshot.revision,
        idempotencyKey: `absent_select_${kind}`, harnessInstanceId: row.id, accessSourceId: `harness_${kind}_native` })).rejects.toThrow("invalid_route");
    } finally { await f.cleanup(); }
  });
  for (const reconcile of [false, true]) {
    it.each(kinds)(`${reconcile ? "reconciled" : "initial"} generated %s configuration does not disable its working native Chat route`, async (kind) => {
      const f = await fixture(kind, reconcile);
      try {
        const catalog = await f.catalog.getCatalog(principal);
        const instance = catalog.instances.find((entry) => entry.driverKind === kind)!;
        expect(instance).toMatchObject({ availability: "available", models: [{ id: "native:working-model" }] });
        expect(instance.defaultSelection).toBeDefined();
        expect(validateChatProviderSelection({ catalog, selection: instance.defaultSelection! }).ok).toBe(true);
      } finally { await f.cleanup(); }
    });
    it.each(kinds)(`${reconcile ? "reconciled" : "initial"} generated %s configuration does not block a fresh Workspace or Project run`, async (kind) => {
      const f = await fixture(kind, reconcile);
      try {
        for (const projectId of [undefined, "matrix-os"]) {
          const response = await f.app.request(post({
            providerId: kind, prompt: "Inspect", clientRequestId: `req_${kind}_${projectId ?? "workspace"}`, ...(projectId ? { projectId } : {}),
          }));
          expect(response.status).toBe(202);
        }
        const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
        expect(config.harnesses.find((entry: { harness: string }) => entry.harness === kind)).toMatchObject({ enablementOrigin: "generated_default" });
      } finally { await f.cleanup(); }
    });
  }
  it.each(kinds)("preserves an ambiguous historical false %s row without inferring owner intent or enabling it", async (kind) => {
    const f = await fixture(kind, false);
    try {
      const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      const row = config.harnesses.find((entry: { harness: string }) => entry.harness === kind);
      row.enabled = false;
      delete row.enablementOrigin;
      await writeFile(f.store.configurationPath, JSON.stringify(config));
      const snapshot = await f.store.getSnapshot();
      expect(snapshot.harnesses.find((entry) => entry.harness === kind)).toMatchObject({ configuredEnabled: false });
      expect((await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind))
        .toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings", setupActions: [] });
      expect((await f.app.request(post({ providerId: kind, prompt: "Inspect", clientRequestId: `req_${kind}_historical` }))).status).toBe(400);
      const persisted = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      expect(persisted.harnesses.find((entry: { harness: string }) => entry.harness === kind)).toEqual(row);
    } finally { await f.cleanup(); }
  });

  it.each(kinds)("explicit owner Off on a generated %s row blocks native catalog and direct admission", async (kind) => {
    const f = await fixture(kind, false);
    try {
      const snapshot = await f.store.getSnapshot();
      const harness = snapshot.harnesses.find((entry) => entry.harness === kind)!;
      await f.store.mutate({ type: "set_harness_enabled", expectedRevision: snapshot.revision,
        idempotencyKey: `owner_off_${kind}`, harnessInstanceId: harness.id, enabled: false });
      expect((await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind))
        .toMatchObject({ availability: "unavailable", unavailabilityReason: "disabled_in_settings", setupActions: [] });
      expect((await f.app.request(post({ providerId: kind, prompt: "Inspect", clientRequestId: `req_${kind}_owner_off` }))).status).toBe(400);
      const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      expect(config.harnesses.find((entry: { harness: string }) => entry.harness === kind))
        .toMatchObject({ enabled: false, enablementOrigin: "owner_configuration" });
    } finally { await f.cleanup(); }
  });
  it.each(kinds)("generated %s defaults do not promote missing native authentication or failed model discovery", async (kind) => {
    const f = await fixture(kind, false);
    try {
      f.summary.availability = "auth_required";
      f.summary.authStatus = "unauthenticated";
      let instance = (await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)!;
      expect(instance.availability).not.toBe("available");
      expect(instance.defaultSelection).toBeUndefined();
      f.summary.availability = "available";
      f.summary.authStatus = "authenticated";
      f.catalogMode.fail = true;
      f.nativeCatalogMode.fail = true;
      await f.store.getSnapshot({ refresh: true });
      instance = (await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)!;
      expect(instance).toMatchObject({ availability: "unavailable", models: [] });
      expect(instance.defaultSelection).toBeUndefined();
    } finally { await f.cleanup(); }
  });

  it.each(kinds)("read/reconcile preserves %s generated origin without claiming owner enablement intent", async (kind) => {
    const f = await fixture(kind, false);
    try {
      let config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      const row = config.harnesses.find((entry: { harness: string }) => entry.harness === kind);
      expect(row).toMatchObject({ enabled: true, enablementOrigin: "generated_default" });
      const snapshot = await f.store.getSnapshot({ refresh: true });
      await f.store.mutate({ type: "update_harness", expectedRevision: snapshot.revision,
        idempotencyKey: `label_${kind}`, harnessInstanceId: row.id, displayName: "Native account" });
      row.displayName = "Native account";
      await f.store.getSnapshot();
      config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
      expect(config.harnesses.find((entry: { harness: string }) => entry.harness === kind)).toEqual(row);
    } finally { await f.cleanup(); }
  });

  it.each(kinds)("shared %s Settings and Chat use the generated native model, credential source, and runnable truth", async (kind) => {
    const f = await fixture(kind, false);
    try {
      const settings = await f.store.getSnapshot();
      const harness = settings.harnesses.find((entry) => entry.harness === kind)!;
      expect(harness).toMatchObject({ enabled: true, configuredEnabled: true, authState: "unknown", connectivity: "unknown",
        accessSourceId: `harness_${kind}_native`, selectedAccountId: null,
        route: { kind: "configurable", providerId: "native", modelId: "native:working-model" } });
      expect(settings.accessSources.find((source) => source.id === harness.accessSourceId)).toMatchObject({ kind: "harness_profile", harness: kind, fundingKind: "owner_account" });
      const instance = (await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)!;
      expect(instance).toMatchObject({ availability: "available", defaultSelection: { model: harness.route.modelId } });
      expect((await f.app.request(post({ providerId: kind, model: harness.route.modelId, prompt: "Inspect", clientRequestId: `req_${kind}_shared_route` }))).status).toBe(202);
      expect(f.startThread).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ model: harness.route.modelId }) }));
      await rm(join(homePathFor(f.homePath, kind), "auth.json"));
      f.canonical.drivers.find((driver) => driver.id === kind)!.health = "unknown";
      f.summary.availability = "auth_required";
      f.summary.authStatus = "unauthenticated";
      const unavailable = (await f.store.getSnapshot({ refresh: true })).harnesses.find((entry) => entry.harness === kind)!;
      expect(unavailable.enabled).toBe(false);
      expect(unavailable.authState).not.toBe("authenticated");
      expect((await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)?.availability).not.toBe("available");
      expect((await f.app.request(post({ providerId: kind, prompt: "Inspect", clientRequestId: `req_${kind}_missing_auth` }))).status).toBe(400);
    } finally { await f.cleanup(); }
  });

  it.each(kinds)("%s without a saved CLI default can explicitly select its matched local native route", async (kind) => {
    const f = await fixture(kind, false);
    try {
      const configPath = kind === "pi" ? join(f.homePath, ".pi/agent/settings.json") : join(f.homePath, ".config/opencode/opencode.json");
      await writeFile(configPath, "{}");
      const before = await f.store.getSnapshot({ refresh: true });
      expect(before.harnesses.find((entry) => entry.harness === kind)?.enabled).toBe(false);
      expect((await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)?.availability).toBe("unavailable");
      const selected = await f.store.mutate({ type: "set_route", harnessInstanceId: `harness_${kind}`, expectedRevision: before.revision,
        idempotencyKey: `select_native_${kind}`, route: { kind: "configurable", providerId: "native", modelId: "native:working-model" },
        accessSourceId: `harness_${kind}_native`, accountId: null, enableHarness: true });
      expect(selected.snapshot.harnesses.find((entry) => entry.harness === kind)).toMatchObject({ enabled: true, authState: "unknown", connectivity: "unknown", enablementOrigin: "owner_configuration" });
      const instance = (await f.catalog.getCatalog(principal)).instances.find((entry) => entry.driverKind === kind)!;
      expect(instance).toMatchObject({ availability: "available", localObservation: { state: "present_unverified" }, defaultSelection: { model: "native:working-model" } });
      expect((await f.app.request(post({ providerId: kind, model: "native:working-model", prompt: "Inspect", clientRequestId: `req_selected_native_${kind}` }))).status).toBe(202);
    } finally { await f.cleanup(); }
  });
  it.each(kinds)("production %s native reader produces canonical V3 consumed by Settings, Chat and Hono", async (kind) => {
    const f = await fixture(kind, false, true);
    const producer = new AiProviderService({ homePath: f.homePath, env: {}, now: () => PROVIDER_SETTINGS_NOW,
      driverInventory: f.readDrivers, nativeHarnessCatalogReader: f.nativeCatalog });
    try {
      const canonical = await producer.getSnapshot();
      expect(canonical.nativeHarnessCatalog?.profiles.find((profile) => profile.harness === kind && profile.providerId === "z-working"))
        .toMatchObject({ defaultModelId: "z-working:saved-model", localObservation: { state: "present_unverified" } });
      const store = new ProviderSettingsStore({ homePath: f.homePath, providerSnapshotReader: producer, now: () => PROVIDER_SETTINGS_NOW });
      const resolver = createCodingHarnessCredentialResolver({ harness: kind, homePath: f.homePath, settings: store,
        now: () => PROVIDER_SETTINGS_NOW, resolveCredentialLaunch: vi.fn() });
      await expect(resolver()).resolves.toEqual({ env: {} });
      const settings = await store.getSnapshot();
      expect(settings.harnesses.find((item) => item.harness === kind)).toMatchObject({ enabled: true, authState: "unknown", route: { providerId: "z-working", modelId: "z-working:saved-model" } });
      const catalog = createChatProviderCatalogService({ now: () => PROVIDER_SETTINGS_NOW,
        codingProviders: { listProviders: async () => [f.summary], invalidate: () => undefined },
        agentRuntimeSource: async () => { throw new Error("No system runtime"); },
        harnessSettingsSource: store, executableDriverKinds: [kind], credentialedDriverKinds: [kind] });
      const instance = (await catalog.getCatalog(principal)).instances.find((item) => item.driverKind === kind)!;
      expect(instance).toMatchObject({ availability: "available", defaultSelection: { model: "z-working:saved-model" }, localObservation: { state: "present_unverified" } });
      const response = await f.app.request(post({ providerId: kind, model: "z-working:saved-model", prompt: "Inspect", clientRequestId: `req_canonical_${kind}` }));
      expect(response.status).toBe(202);
      expect(f.startThread).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ model: "z-working:saved-model" }) }));
    } finally { producer.close(); await f.cleanup(); }
  });
  it.each(kinds)("canonical %s catalog failure cannot be bypassed by legacy enrichment", async (kind) => {
    const f = await fixture(kind, false);
    const producer = new AiProviderService({ homePath: f.homePath, env: {}, now: () => PROVIDER_SETTINGS_NOW,
      driverInventory: f.readDrivers, nativeHarnessCatalogReader: f.nativeCatalog });
    try {
      const stale = await f.nativeCatalog.getCatalog(); f.nativeCatalogMode.fail = true;
      await producer.getSnapshot({ refresh: true });
      const fallback = vi.fn(async () => stale);
      const store = new ProviderSettingsStore({ homePath: f.homePath, providerSnapshotReader: producer,
        now: () => PROVIDER_SETTINGS_NOW, genericModelCatalogReader: { getCatalog: fallback } });
      const settings = await store.getSnapshot();
      expect(settings.harnesses.find((item) => item.harness === kind)).toMatchObject({ enabled: false, routeAvailability: "catalog_unavailable" });
      expect(fallback).not.toHaveBeenCalled();
    } finally { producer.close(); await f.cleanup(); }
  });
  it.each(kinds)("explicit %s route cannot borrow another native provider's credential", async (kind) => {
    const f = await fixture(kind, false, true);
    try {
      const before = await f.store.getSnapshot();
      await expect(f.store.mutate({ type: "set_route", harnessInstanceId: `harness_${kind}`, expectedRevision: before.revision,
        idempotencyKey: `select_unbound_${kind}`, route: { kind: "configurable", providerId: "a-no-auth", modelId: "a-no-auth:listed-model" },
        accessSourceId: `harness_${kind}_a-no-auth`, accountId: null, enableHarness: true })).rejects.toMatchObject({ code: "invalid_route" });
      const off = await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: `harness_${kind}`, expectedRevision: before.revision,
        idempotencyKey: `turn_off_${kind}`, enabled: false });
      const selected = await f.store.mutate({ type: "set_route", harnessInstanceId: `harness_${kind}`, expectedRevision: off.snapshot.revision,
        idempotencyKey: `select_off_${kind}`, route: { kind: "configurable", providerId: "a-no-auth", modelId: "a-no-auth:listed-model" },
        accessSourceId: `harness_${kind}_a-no-auth`, accountId: null });
      await expect(f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: `harness_${kind}`, expectedRevision: selected.snapshot.revision,
        idempotencyKey: `enable_unbound_${kind}`, enabled: true })).rejects.toMatchObject({ code: "invalid_route" });
      expect((await f.catalog.getCatalog(principal)).instances.find((item) => item.driverKind === kind)?.availability).toBe("unavailable");
      expect((await f.app.request(post({ providerId: kind, model: "a-no-auth:listed-model", prompt: "Inspect", clientRequestId: `req_unbound_${kind}` }))).status).toBe(400);
      const resolver = createCodingHarnessCredentialResolver({ harness: kind, homePath: f.homePath, settings: f.store,
        now: () => PROVIDER_SETTINGS_NOW, resolveCredentialLaunch: vi.fn() });
      await expect(resolver()).rejects.toThrow("Selected coding harness access is unavailable");
    } finally { await f.cleanup(); }
  });
  it.each(kinds)("multiple listed %s providers cannot promote the first unbound provider over the saved native route", async (kind) => {
    const f = await fixture(kind, false, true);
    try {
      const settings = await f.store.getSnapshot();
      const harness = settings.harnesses.find((entry) => entry.harness === kind)!;
      expect(harness).toMatchObject({ enabled: true, authState: "unknown", route: { providerId: "z-working", modelId: "z-working:saved-model" } });
      expect(settings.accessSources.find((source) => source.providerId === "a-no-auth")).toMatchObject({ localObservation: { state: "absent" }, readiness: { state: "unknown" } });
    } finally { await f.cleanup(); }
  });

});
