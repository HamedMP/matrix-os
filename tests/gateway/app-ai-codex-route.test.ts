import { describe, expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createRuntimeAppAiService } from "../../packages/gateway/src/app-ai/runtime.js";
import type { ProviderSnapshotReadOptions } from "../../packages/gateway/src/ai-providers/snapshot-read-options.js";

const route = { harnessId: "harness_codex", accountId: "owner_codex", accessSourceId: "owner_openai_profile", modelId: "gpt-5.6-sol" };
const prompt = "Respond with the number 21";
function fixture() {
  const time = new Date().toISOString();
  const staleAfter = new Date(Date.now() + 10_000).toISOString();
  const settings = {
    access: { mode: "writable" },
    harnesses: [{ id: route.harnessId, harness: "codex", displayName: "Codex", enabled: true, configuredEnabled: true,
      installState: "installed", accessSourceId: route.accessSourceId, selectedAccountId: route.accountId,
      route: { kind: "fixed", providerId: "openai", modelId: route.modelId } }],
    accounts: [{ id: route.accountId, providerId: "openai", accessSourceId: route.accessSourceId,
      authState: "authenticated", authMethod: "terminal", lastCheckedAt: time }],
    accessSources: [{ id: route.accessSourceId, kind: "provider_account", providerId: "openai",
      accountId: route.accountId, fundingKind: "owner_account", eligibleModelIds: [route.modelId],
      readiness: { state: "ready", checkedAt: time, staleAfter } }],
    modelProviders: [{ id: "openai", models: [{ id: route.modelId, enabled: true, displayName: "GPT 5.6 Sol" }] }],
  } as unknown as ProviderSettingsSnapshot;
  const canonical = {
    accessSources: [{ id: route.accessSourceId, vendor: "openai", fundingKind: "owner_account", eligibleModelIds: [route.modelId], state: "unknown" }],
    models: [{ id: route.modelId, vendor: "openai", status: "active", eligibleAccessSourceIds: [route.accessSourceId] }],
    accounts: [{ id: route.accountId, vendor: "openai" }],
    instances: [{ driverId: "codex", vendor: "openai", accountId: route.accountId, accessSourceId: route.accessSourceId, modelIds: [route.modelId] }],
    drivers: [{ id: "codex", installState: "installed" }],
  } as unknown as AiProviderSnapshotV3;
  const probe = vi.fn(async () => true);
  const generate = vi.fn(async ({ revalidate }: { revalidate: () => Promise<boolean> }) => {
    if (!await revalidate()) throw new Error("Grant revoked");
    return { text: "21" };
  });
  const readSettings = vi.fn(async (_options?: ProviderSnapshotReadOptions) => settings);
  const service = createRuntimeAppAiService({
    homePath: "/matrix-home", ownerIds: ["owner"], codexProfileCompletion: { probe, generate },
    providerSnapshotReader: { getSnapshot: async () => canonical },
    providerSettingsReader: { getSnapshot: readSettings },
  });
  return { settings, canonical, probe, generate, readSettings, service: service.hostedBots };
}

describe("hosted Bots native Codex route", () => {
  it("offers the connected native owner route independently of canonical funding readiness", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    expect((await run.service.discover(signal)).routes).toEqual([expect.objectContaining({
      ...route, displayName: "Codex", modelLabel: "GPT 5.6 Sol", supportsManagedTools: false,
    })]);
    expect(await run.service.generate({ route, prompt, signal })).toEqual({ text: "21" });
    expect(run.generate).toHaveBeenCalledWith(expect.objectContaining({ route, prompt }));
    expect(run.readSettings.mock.calls.at(-1)?.[0]).toMatchObject({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false, suppressFundedProbes: true });
  });

  it("omits unavailable app-server implementations and rejects another source, account or model", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    run.probe.mockResolvedValueOnce(false);
    expect((await run.service.discover(signal)).routes).toEqual([]);
    for (const selection of [
      { ...route, accountId: "different" }, { ...route, accessSourceId: "chatgpt_plan" }, { ...route, modelId: "unknown" },
    ]) await expect(run.service.generate({ route: selection, prompt, signal })).rejects.toThrow();
    expect(run.generate).not.toHaveBeenCalled();
  });

  it("rejects an API-key profile, future-dated readiness, and consent revoked during preparation", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    run.settings.accounts[0]!.authMethod = "api_key";
    expect((await run.service.discover(signal)).routes).toEqual([]);
    run.settings.accounts[0]!.authMethod = "terminal";
    const originalTime = run.settings.accessSources[0]!.readiness.checkedAt;
    run.settings.accessSources[0]!.readiness.checkedAt = "2126-01-01T00:00:00.000Z";
    expect((await run.service.discover(signal)).routes).toEqual([]);
    run.settings.accessSources[0]!.readiness.checkedAt = originalTime;
    run.generate.mockImplementationOnce(async ({ revalidate }) => {
      run.settings.harnesses[0]!.configuredEnabled = false;
      expect(await revalidate()).toBe(false);
      throw new Error("Grant revoked");
    });
    await expect(run.service.generate({ route, prompt, signal })).rejects.toThrow("Grant revoked");
  });
});
