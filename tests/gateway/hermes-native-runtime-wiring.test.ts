import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntimeServices } from "../../packages/gateway/src/agent-config/runtime-services.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { createHermesRuntimeSource } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { createCanonicalNativeHarnessCatalogReader } from "../../packages/gateway/src/ai-providers/native-harness-canonical-projection.js";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";

it("preserves OpenClaw discovery while renewing Hermes after a shared slow catalog wait", async () => {
  let clock = 0;
  const coding = Promise.withResolvers<{ providers: []; accessSources: []; failures: [] }>();
  const hermes = createHermesRuntimeSource(async path => path === "/api/status" ? { gateway_running: false } : {
    provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }],
  }, { now: () => clock });
  const openclaw = vi.fn(async () => ({
    runtime: { selected: "openclaw", options: [{ id: "openclaw", installState: "installed", health: "healthy" }] },
    messaging: { runtime: "openclaw", provider: "anthropic", model: "native-model", configured: true },
    providers: [{ id: "anthropic", runtime: "openclaw", displayName: "Anthropic", authKind: "api_key",
      authStatus: { state: "ready", authenticated: true }, models: [{ id: "native-model", displayName: "Native model", available: true }] }],
  }) as unknown as AgentRuntimeSettingsSnapshot);
  const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: () => coding.promise },
    { hermesRuntimeSource: hermes, openclawRuntimeSource: openclaw, now: () => new Date(clock) });
  const request = reader(true);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  clock = 6000;
  coding.resolve({ providers: [], accessSources: [], failures: [] });
  const catalog = await request;
  expect(catalog.profiles.find(profile => profile.harness === "hermes")?.localObservation.checkedAt).toBe(new Date(6000).toISOString());
  expect(catalog.profiles.find(profile => profile.harness === "openclaw")?.defaultModelId).toBe("anthropic:native-model");
  expect(openclaw).toHaveBeenCalledOnce();
  expect(catalog.failures).toEqual([]);
});

// Exercise the production dependency choice with real runtime composition.
// The messaging projection intentionally omits native-only profile evidence.
async function productionSource(services: ReturnType<typeof createAgentRuntimeServices>) {
  const server = await readFile(new URL("../../packages/gateway/src/server.ts", import.meta.url), "utf8");
  const binding = server.match(/hermesRuntimeSource:\s*agentRuntimeServices\.(source|systemRuntimeSources\.hermes)\s*,/);
  if (!binding) throw new Error("Production Hermes native source binding is missing");
  return binding[1] === "source" ? services.source : services.systemRuntimeSources.hermes;
}

describe("production Hermes native catalog wiring", () => {
  it.each([true, false])("refreshes cached native credential evidence for each catalog read (authenticated: %s)", async (authenticated) => {
    let clock = 0;
    let currentAuth = true;
    const source = createHermesRuntimeSource(async (path) => path === "/api/status" ? { gateway_running: false } : {
      provider: "openai-codex", model: "gpt-5.6-sol", providers: [{
        slug: "openai-codex", authenticated: currentAuth, is_user_defined: false, models: ["gpt-5.6-sol"],
      }],
    }, { now: () => clock });
    await source(AbortSignal.timeout(1000));
    clock = 4000;
    currentAuth = authenticated;
    const reader = createCanonicalNativeHarnessCatalogReader({
      getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }),
    }, { hermesRuntimeSource: source, now: () => new Date(clock) });
    const catalog = await reader(false);
    if (authenticated) {
      expect(catalog.profiles[0]?.localObservation).toEqual({ state: "present_unverified",
        checkedAt: new Date(4000).toISOString(), staleAfter: new Date(9000).toISOString() });
    } else {
      expect(catalog).toEqual({ profiles: [], failures: ["hermes"] });
    }
  });

  it.each(["copilot", "openai-codex"])("retains Codex evidence with native default %s", async (provider) => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-native-wiring-"));
    const mutateNative = vi.fn();
    const services = createAgentRuntimeServices({ homePath,
      hostControl: {
        status: async () => ({ hermes: { installed: true, running: true }, openclaw: { installed: false, running: false } }),
        switch: mutateNative, stop: mutateNative,
      },
      client: {
        readJson: async (path) => path === "/api/status" ? { gateway_running: false } : {
          provider, model: "gpt-5.6-sol", providers: [
            { slug: "copilot", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] },
            { slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol", "gpt-5.6-luna"] },
          ],
        },
        requestJson: mutateNative,
      },
    });
    const producer = new AiProviderService({ homePath, env: {},
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: await productionSource(services),
    });
    try {
      const snapshot = await producer.getSnapshot({ refresh: true });
      expect(snapshot.nativeHarnessCatalog).toMatchObject({ profiles: [{
        harness: "hermes", providerId: "openai-codex",
        defaultModelId: provider === "openai-codex" ? "openai-codex:gpt-5.6-sol" : null,
        models: expect.arrayContaining([
          { id: "openai-codex:gpt-5.6-sol", displayName: "gpt-5.6-sol", enabled: true },
          { id: "openai-codex:gpt-5.6-luna", displayName: "gpt-5.6-luna", enabled: true },
        ]), localObservation: { state: "present_unverified" },
      }], failures: [] });
      expect(mutateNative).not.toHaveBeenCalled();
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
});


describe("native observation renewal ordering", () => {
  it("timestamps the options receipt, retaining strict five-second expiry after a slow probe", async () => {
    let clock = 0;
    const source = createHermesRuntimeSource(async (path) => {
      if (path === "/api/status") return { gateway_running: false };
      clock = 5001;
      return { provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }] };
    }, { now: () => clock });
    const result = await source(AbortSignal.timeout(6500));
    expect(result.nativeProfileObservations?.[0]?.localObservation).toEqual({ state: "present_unverified", checkedAt: new Date(5001).toISOString(), staleAfter: new Date(10001).toISOString() });
  });

  it("renews once when slow coding discovery consumes Hermes evidence, without repeating coding discovery", async () => {
    let clock = 0;
    const coding = Promise.withResolvers<{ providers: []; accessSources: []; failures: [] }>();
    const getCatalog = vi.fn(() => coding.promise);
    const readJson = vi.fn(async (path: string) => path === "/api/status" ? { gateway_running: false } : {
      provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }],
    });
    const source = createHermesRuntimeSource(readJson, { now: () => clock });
    const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog }, { hermesRuntimeSource: source, now: () => new Date(clock) });
    const request = reader(true);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    clock = 6000; coding.resolve({ providers: [], accessSources: [], failures: [] });
    const catalog = await request;
    expect(catalog.profiles[0]?.localObservation.checkedAt).toBe(new Date(6000).toISOString());
    expect(catalog.profiles[0]?.localObservation.staleAfter).toBe(new Date(11000).toISOString());
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(readJson.mock.calls.filter(([path]) => path === "/api/model/options")).toHaveLength(2);
  });

  it("renews near final V3 projection after an unrelated driver wait", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "hermes-final-freshness-"));
    let clock = 0;
    const drivers = Promise.withResolvers<[]>();
    const observed = Promise.withResolvers<void>();
    const source = createHermesRuntimeSource(async (path) => {
      if (path === "/api/status") return { gateway_running: false };
      observed.resolve();
      return { provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }] };
    }, { now: () => clock });
    const producer = new AiProviderService({ homePath, env: {}, now: () => new Date(clock), driverInventory: () => drivers.promise,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) }, hermesRuntimeSource: source });
    try {
      const request = producer.getSnapshot({ refresh: true });
      await observed.promise;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      clock = 6000; drivers.resolve([]);
      const catalog = (await request).nativeHarnessCatalog;
      expect(catalog?.profiles[0]?.localObservation.checkedAt).toBe(new Date(6000).toISOString());
    } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
  });
});

it.each(["openai-codex", "openai-api", "anthropic", "openrouter"])("renews positive %s options evidence consumed by slow status, but preserves a new negative", async provider => {
  for (const authenticated of [true, false]) {
    let clock = 0;
    const status = Promise.withResolvers<{ gateway_running: false }>();
    let statusReads = 0;
    const readJson = vi.fn(async (path: string) => {
      if (path === "/api/status") return ++statusReads === 1 ? status.promise : { gateway_running: false };
      return { provider, model: "native-model", providers: [{ slug: provider, authenticated: statusReads === 1 ? true : authenticated,
        auth_type: provider === "openai-codex" ? "oauth" : "api_key", is_user_defined: false, models: ["native-model"] }] };
    });
    const source = createHermesRuntimeSource(readJson, { now: () => clock });
    const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      { hermesRuntimeSource: source, now: () => new Date(clock) });
    const request = reader(true);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    clock = 6000; status.resolve({ gateway_running: false });
    const catalog = await request;
    if (authenticated) expect(catalog.profiles).toEqual([expect.objectContaining({ providerId: provider,
      models: [{ id: `${provider}:native-model`, displayName: "native-model", enabled: true }],
      localObservation: { state: "present_unverified", checkedAt: new Date(6000).toISOString(), staleAfter: new Date(11000).toISOString() },
    })]);
    else expect(catalog).toEqual({ profiles: [], failures: ["hermes"] });
    expect(readJson.mock.calls.filter(([path]) => path === "/api/model/options")).toHaveLength(2);
  }
});

it("does not retry proven absence and aborts a shared bounded catalog wait promptly", async () => {
  const absent = createHermesRuntimeSource(async path => path === "/api/status" ? { gateway_running: false } : {
    provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: false, is_user_defined: false, models: ["gpt-5.6-sol"] }],
  });
  const reader = createCanonicalNativeHarnessCatalogReader({ getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) }, { hermesRuntimeSource: absent });
  expect(await reader(true)).toEqual({ profiles: [], failures: ["hermes"] });
  const coding = Promise.withResolvers<{ providers: []; accessSources: []; failures: [] }>();
  const other = createCanonicalNativeHarnessCatalogReader({ getCatalog: () => coding.promise });
  const controller = new AbortController();
  const pending = other(true, { signal: controller.signal, deadline: Date.now() + 13000 });
  const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort(); await result;
  coding.resolve({ providers: [], accessSources: [], failures: [] });
});

it("collects Codex local evidence after slow conditional Hermes renewal", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "hermes-codex-observation-order-"));
  let clock = 0;
  let reads = 0;
  const observed = Promise.withResolvers<void>();
  const drivers = Promise.withResolvers<[]>();
  const source = createHermesRuntimeSource(async path => {
    if (path === "/api/status") return { gateway_running: false };
    reads += 1;
    if (reads > 1) clock += 5001;
    observed.resolve();
    return { provider: "openai-codex", model: "gpt-5.6-sol", providers: [{ slug: "openai-codex", authenticated: true, is_user_defined: false, models: ["gpt-5.6-sol"] }] };
  }, { now: () => clock });
  const codexLocalObservation = vi.fn(async () => ({ accessSourceId: "owner_openai_profile", state: "present_unverified" as const,
    checkedAt: new Date(clock).toISOString(), staleAfter: new Date(clock + 5000).toISOString() }));
  const producer = new AiProviderService({ homePath, env: {}, now: () => new Date(clock), driverInventory: () => drivers.promise,
    nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) }, hermesRuntimeSource: source, codexLocalObservation });
  try {
    const request = producer.getSnapshot({ refresh: true });
    await observed.promise;
    for (let i = 0; i < 30; i++) await Promise.resolve();
    clock = 6000; drivers.resolve([]);
    const snapshot = await request;
    expect(snapshot.nativeHarnessCatalog?.profiles[0]?.localObservation.checkedAt).toBe(new Date(11001).toISOString());
    expect(snapshot.accessSources.find(source => source.id === "owner_openai_profile")?.localObservation?.checkedAt).toBe(new Date(11001).toISOString());
    expect(codexLocalObservation).toHaveBeenCalledTimes(2);
  } finally { producer.close(); await rm(homePath, { recursive: true, force: true }); }
});
