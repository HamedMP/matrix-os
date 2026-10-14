import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createGenericHarnessModelCatalogReader } from "../../packages/gateway/src/ai-providers/generic-harness-model-catalog.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createFakeCodingAgentProvider } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsFundingSummaryFixture } from "./provider-settings-test-support.js";

afterEach(() => vi.unstubAllEnvs());

const cases = (["pi", "opencode"] as const).flatMap(kind => [
  { kind, waitLayer: "canonical", delay: 6_001, removeAuth: false, expectedEnabled: true },
  { kind, waitLayer: "settings", delay: 6_001, removeAuth: false, expectedEnabled: true },
  { kind, waitLayer: "canonical", delay: 4_000, removeAuth: false, expectedEnabled: true },
  { kind, waitLayer: "canonical", delay: 6_001, removeAuth: true, expectedEnabled: false },
  { kind, waitLayer: "canonical", delay: 13_001, removeAuth: false, expectedEnabled: false },
]).map(value => ({ ...value, queueDelay: 0, readBudget: 13_000 }));
cases.push(...(["pi", "opencode"] as const).map(kind => ({
  kind, waitLayer: "canonical", delay: 6_000, queueDelay: 8_000, readBudget: 13_000, removeAuth: false, expectedEnabled: false,
})));
cases.push(...(["pi", "opencode"] as const).map(kind => ({
  kind, waitLayer: "canonical", delay: 6_001, queueDelay: 0, readBudget: 6_000, removeAuth: false, expectedEnabled: false,
})));
it.each(cases)("$kind native observation across $waitLayer queue=$queueDelay budget=$readBudget delay=$delay revoked=$removeAuth", async ({ kind, waitLayer, delay, queueDelay, readBudget, removeAuth, expectedEnabled }) => {
  const homePath = await mkdtemp(join(tmpdir(), "provider-observation-ttl-"));
  let clock = +PROVIDER_SETTINGS_NOW;
  const now = () => new Date(clock);
  vi.stubEnv("XDG_CONFIG_HOME", join(homePath, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(homePath, ".local/share"));
  const configDir = join(homePath, kind === "pi" ? ".pi/agent" : ".config/opencode");
  const authDir = join(homePath, kind === "pi" ? ".pi/agent" : ".local/share/opencode");
  await mkdir(configDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await writeFile(join(configDir, kind === "pi" ? "settings.json" : "opencode.json"), JSON.stringify(
    kind === "pi" ? { defaultProvider: "native", defaultModel: "working-model" } : { model: "native/working-model" }));
  await writeFile(join(authDir, "auth.json"), JSON.stringify({ native:
    kind === "pi" ? { type: "api_key", key: "synthetic-test-only" } : { type: "api", key: "synthetic-test-only" } }));
  const observed = Promise.withResolvers<void>();
  const funded = Promise.withResolvers<void>();
  const recoveryEntered = Promise.withResolvers<void>();
  const recoveryGate = Promise.withResolvers<void>();
  let recovered = !queueDelay;
  const canonicalEntered = Promise.withResolvers<void>();
  let canonicalReads = 0;
  const run = vi.fn(async () => ({ stdout: kind === "pi"
    ? "provider model context max-out thinking images\nnative working-model 200000 32000 yes no"
    : "native/working-model", stderr: "" }));
  const nativeReader = createGenericHarnessModelCatalogReader({ homePath, enabledHarnesses: [kind], now, run });
  const getCatalog = vi.fn(async (input = {}) => {
    const value = await nativeReader.getCatalog(input);
    observed.resolve();
    return value;
  });
  const producer = new AiProviderService({ homePath, now,
    env: { MATRIX_PLATFORM_KEY: "synthetic-runtime", MATRIX_FUNDED_AI_ENABLED: "true" },
    fundedCredentialProvider: { enabled: true, maxRunMs: 600_000,
      getCredential: async () => { throw new Error("No credentials during catalog reads"); }, invalidate: () => undefined, close: () => undefined },
    fundedReadinessReader: { read: async () => {
      canonicalReads += 1;
      if (canonicalReads === 2) canonicalEntered.resolve();
      if (waitLayer === "canonical") await funded.promise; return {
      readiness: { state: "ready", checkedAt: now().toISOString(), staleAfter: new Date(clock + 30_000).toISOString(), action: "none", safeReason: null },
      allowedModelIds: ["claude-sonnet-5"],
    }; } },
    driverInventory: async () => [{ id: kind, displayName: kind, kind: "cli", installState: "installed", health: "unknown", capabilities: ["tools", "resume"], setupActions: [] }],
    nativeHarnessCatalogReader: { ...nativeReader, getCatalog },
  });
  const store = new ProviderSettingsStore({ homePath, now, providerSnapshotReader: producer,
    runtimeCoordinator: {
      supportedActions: [], isRecoveryReady: () => recovered,
      reconcilePending: async () => { recoveryEntered.resolve(); await recoveryGate.promise; recovered = true; },
      applyConfiguration: async () => undefined, rollbackConfiguration: async () => undefined,
    },
    fundingSummaryReader: { getFundingSummary: async () => { await funded.promise; return providerSettingsFundingSummaryFixture(); } },
  });
  try {
    // A prior serialized recovery holds the real Settings queue. The second
    // request owns its budget before it waits; Service must not restart it.
    const priorRead = queueDelay ? store.getSnapshot({ refresh: true }) : undefined;
    if (priorRead) await recoveryEntered.promise;
    const request = store.getSnapshot({ nativeObservationDeadline: clock + readBudget });
    clock += queueDelay;
    recoveryGate.resolve();
    await observed.promise;
    if (queueDelay) await canonicalEntered.promise;
    // Native evidence is fresh at discovery but expires while unrelated funding settles.
    clock += delay;
    if (removeAuth) await rm(join(authDir, "auth.json"));
    funded.resolve();
    const settings = await request;
    await priorRead;
    const harness = settings.harnesses.find(row => row.harness === kind)!;
    expect(harness.enabled).toBe(expectedEnabled);
    const source = settings.accessSources.find(row => row.harness === kind)!;
    if (expectedEnabled) expect(Date.parse(source.localObservation!.staleAfter!)).toBeGreaterThan(clock);
    if (delay < 5_000) expect(source.localObservation?.checkedAt).toBe(PROVIDER_SETTINGS_NOW.toISOString());
    if (removeAuth) expect(source.localObservation?.state).not.toBe("present_unverified");
    expect(source.readiness.state).toBe("unknown");
    expect(harness.authState).not.toBe("authenticated");
    expect(run).toHaveBeenCalledOnce();
    const provider = createFakeCodingAgentProvider({ providerId: kind });
    const summary = { ...provider.getSummary!({ now }), id: kind, kind,
      availability: "available" as const, installStatus: "installed" as const,
      authStatus: "authenticated" as const, supportedModes: ["default"], defaultMode: "default", defaultModel: "native:working-model", setupActions: [] };
    const catalog = createChatProviderCatalogService({ now,
      codingProviders: { listProviders: async () => [summary], invalidate: () => undefined },
      agentRuntimeSource: async () => { throw new Error("No system runtime in fixture"); },
      harnessSettingsSource: { getSnapshot: async () => settings }, executableDriverKinds: [kind], credentialedDriverKinds: [kind],
    });
    const instance = (await catalog.getCatalog({ userId: "synthetic_owner", source: "jwt" })).instances.find(row => row.driverKind === kind)!;
    if (expectedEnabled) expect(instance).toMatchObject({ availability: "available", defaultSelection: { model: "native:working-model" } });
    else expect(instance.availability).not.toBe("available");
  } finally { recoveryGate.resolve(); funded.resolve(); producer.close(); await rm(homePath, { recursive: true, force: true }); }
});
