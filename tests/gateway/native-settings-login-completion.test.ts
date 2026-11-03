import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProviderSettingsRuntimeCoordinator } from "../../packages/gateway/src/ai-providers/provider-settings-coordinators.js";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { enableNativeSettingsConnectedRoute } from "../../packages/gateway/src/ai-providers/opencode-settings-auth.js";

const now = new Date("2026-10-30T00:00:00Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(provider = "openai-codex", options: {
  supportedActions?: ProviderSettingsRuntimeCoordinator["supportedActions"];
  authenticated?: boolean;
  staleObservation?: boolean;
  runtimeFailure?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-login-completion-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const homePath = join(root, "home");
  const configurationPath = join(homePath, "system/ai-providers/settings.json");
  const model = provider === "anthropic" ? "claude-opus-4-6" : "gpt-6-sol";
  const native = normalizeHermesRuntimeSnapshot({ observedAt: +now - (options.staleObservation ? 5000 : 0), status: { gateway_running: false }, options: {
    provider, model, providers: [{ slug: provider, is_user_defined: false, auth_type: "oauth",
      authenticated: options.authenticated !== false, models: [model] }],
  } });
  const producer = new AiProviderService({ homePath, env: {}, now: () => now,
    nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
    hermesRuntimeSource: async () => native,
    driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
      health: "ready", capabilities: ["tools"], setupActions: [] }],
  });
  cleanups.push(async () => producer.close());
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(configurationPath, JSON.stringify({ schemaVersion: 1, revision: 7, receipts: [],
    accountProfiles: [], gatewayPolicy: null, harnesses: [{ id: "harness_hermes", driverId: "hermes", harness: "hermes",
      displayName: "Hermes", accentColor: null, enabled: false, enablementOrigin: "owner_configuration",
      selectedAccountId: null, accessSourceId: `harness_hermes_${provider}`,
      route: { kind: "configurable", providerId: provider, modelId: `${provider}:${model}` } }],
  }));
  let applications = 0;
  const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, "private"), now: () => now,
    providerSnapshotReader: producer, runtimeCoordinator: {
      supportedActions: options.supportedActions ?? ["set_route", "set_harness_enabled"], supportedHarnessKinds: ["hermes"],
      isRecoveryReady: () => true, reconcilePending: async () => {},
      applyConfiguration: async () => { applications++; if (options.runtimeFailure) throw new Error("fixture runtime unavailable"); },
      rollbackConfiguration: async () => {},
    },
  });
  return { store, provider, model, configurationPath, applications: () => applications,
    saved: async () => JSON.parse(await readFile(configurationPath, "utf8")) };
}

// Fault detected: using the HTTP-only atomicConnectSupported decoration in an
// internal completion rejects a real Store snapshot before its atomic writer.
it.each(["openai-codex", "anthropic"])("records %s login completion through the real internal Store", async provider => {
  const f = await fixture(provider);
  const before = await f.store.getSnapshot({ refresh: true });
  expect(before.supportedActions).toEqual(expect.arrayContaining(["set_route", "set_harness_enabled"]));
  expect(before.atomicConnectSupported).toBeUndefined();
  await enableNativeSettingsConnectedRoute(f.store, "harness_hermes", "hermes", provider as "openai-codex" | "anthropic", "login-completed", before.revision);
  const saved = await f.saved();
  expect(saved.revision).toBe(8);
  expect(saved.harnesses[0]).toMatchObject({ enabled: true, selectedAccountId: null,
    accessSourceId: `harness_hermes_${provider}`, route: { providerId: provider, modelId: `${provider}:${f.model}` } });
  expect(saved.receipts).toEqual([expect.objectContaining({ key: "login-completed" })]);
  expect(f.applications()).toBe(1);
});

it.each(["set_route", "set_harness_enabled"] as const)("rejects completion without %s even if a caller adds the public flag", async missing => {
  const f = await fixture("openai-codex", { supportedActions: missing === "set_route" ? ["set_harness_enabled"] : ["set_route"] });
  const before = await f.saved();
  const decorated = { getSnapshot: async () => ({ ...await f.store.getSnapshot({ refresh: true }), atomicConnectSupported: true }),
    mutate: f.store.mutate.bind(f.store) };
  await expect(enableNativeSettingsConnectedRoute(decorated, "harness_hermes", "hermes", "openai-codex", "denied", 7)).rejects.toThrow("unavailable");
  expect(await f.saved()).toEqual(before);
  expect(f.applications()).toBe(0);
});

it("preserves an owner revision changed during OAuth", async () => {
  const f = await fixture();
  const before = await f.saved();
  await expect(enableNativeSettingsConnectedRoute(f.store, "harness_hermes", "hermes", "openai-codex", "old-revision", 6)).rejects.toThrow("unavailable");
  expect(await f.saved()).toEqual(before);
  expect(f.applications()).toBe(0);
});

it("does not enable an absent native credential", async () => {
  const f = await fixture("openai-codex", { authenticated: false });
  const before = await f.saved();
  await expect(enableNativeSettingsConnectedRoute(f.store, "harness_hermes", "hermes", "openai-codex", "absent", 7)).rejects.toThrow("unavailable");
  expect(await f.saved()).toEqual(before);
  expect(f.applications()).toBe(0);
});

it("does not enable a native profile whose observation has expired", async () => {
  const f = await fixture("openai-codex", { staleObservation: true });
  const before = await f.saved();
  await expect(enableNativeSettingsConnectedRoute(f.store, "harness_hermes", "hermes", "openai-codex", "stale", 7)).rejects.toThrow("unavailable");
  expect(await f.saved()).toEqual(before);
  expect(f.applications()).toBe(0);
});

it("lets the real atomic Store reject an owner mutation raced after the completion read", async () => {
  const f = await fixture();
  const raced = { getSnapshot: f.store.getSnapshot.bind(f.store), mutate: async (mutation: Parameters<typeof f.store.mutate>[0]) => {
    await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: "harness_hermes", enabled: false,
      expectedRevision: 7, idempotencyKey: "owner-disable" });
    return f.store.mutate(mutation);
  } };
  await expect(enableNativeSettingsConnectedRoute(raced, "harness_hermes", "hermes", "openai-codex", "raced-login", 7)).rejects.toThrow("revision_conflict");
  const saved = await f.saved();
  expect(saved.revision).toBe(8);
  expect(saved.harnesses[0].enabled).toBe(false);
  expect(saved.receipts.map((receipt: { key: string }) => receipt.key)).toEqual(["owner-disable"]);
  expect(f.applications()).toBe(1);
});

it("does not commit a connected route when native application fails", async () => {
  const f = await fixture("openai-codex", { runtimeFailure: true });
  const before = await f.saved();
  await expect(enableNativeSettingsConnectedRoute(f.store, "harness_hermes", "hermes", "openai-codex", "native-failed", 7)).rejects.toThrow("runtime_unavailable");
  expect(await f.saved()).toEqual(before);
  expect(f.applications()).toBe(1);
});
