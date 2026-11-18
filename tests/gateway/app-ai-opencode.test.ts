import { describe, expect, it, vi } from "vitest";
import type { AiProviderSnapshotV3, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createRuntimeAppAiService } from "../../packages/gateway/src/app-ai/runtime.js";

const route = { harnessId: "harness_opencode", accountId: null, accessSourceId: "harness_opencode_opencode", modelId: "opencode:beam-free" };
const prompt = "Respond with the number 11";

function fixture() {
  const settings = { harnesses: [], accounts: [], accessSources: [], modelProviders: [] } as unknown as ProviderSettingsSnapshot;
  const canonical = {
    accessSources: [], models: [], accounts: [], instances: [],
    drivers: [{ id: "opencode", installState: "installed", health: "unknown", displayName: "OpenCode" }],
    nativeHarnessCatalog: {
      failures: [],
      profiles: [{ harness: "opencode", providerId: "opencode", models: [
        { id: route.modelId, displayName: "Beam Free", enabled: true },
        { id: "opencode:gpt-paid", displayName: "Paid", enabled: true },
      ] }],
    },
  } as unknown as AiProviderSnapshotV3;
  const probe = vi.fn(async () => true);
  const generate = vi.fn(async ({ revalidate }: { revalidate: () => Promise<boolean> }) => {
    if (!await revalidate()) throw new Error("Grant revoked");
    return { text: "11" };
  });
  const service = createRuntimeAppAiService({
    homePath: "/matrix-home", ownerIds: ["owner"], openCodeCompletion: { probe, generate },
    providerSnapshotReader: { getSnapshot: async () => canonical },
    providerSettingsReader: { getSnapshot: async () => settings },
  });
  return { settings, canonical, probe, generate, service: service.hostedBots };
}

describe("hosted Bots native OpenCode Free routes", () => {
  it("only exposes exact built-in free models, as text, and runs the selected route", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    const catalog = await run.service.discover(signal);
    expect(catalog.defaultRoute).toBeNull();
    expect(catalog.routes).toEqual([expect.objectContaining({ ...route, displayName: "OpenCode Free", modelLabel: "Beam Free", supportsManagedTools: false })]);
    expect((await run.service.discover(signal, "managed")).routes).toEqual([]);
    expect(await run.service.generate({ route, prompt, signal })).toEqual({ text: "11" });
    expect(run.generate).toHaveBeenCalledWith(expect.objectContaining({ modelId: route.modelId, prompt }));
  });

  it("rejects paid, wrong account, cross-source, and stale selections", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    for (const selection of [{ ...route, modelId: "opencode:gpt-paid" }, { ...route, accountId: "owner" }, { ...route, accessSourceId: "harness_other" }]) {
      await expect(run.service.generate({ route: selection, prompt, signal })).rejects.toThrow();
    }
    run.canonical.nativeHarnessCatalog!.profiles = [];
    await expect(run.service.generate({ route, prompt, signal })).rejects.toThrow();
    expect(run.generate).not.toHaveBeenCalled();
  });

  it("respects explicit Settings Off and revalidates revocation before passing prompt", async () => {
    const run = fixture();
    run.settings.harnesses = [{ id: route.harnessId, harness: "opencode", accessSourceId: null,
      enabled: false, configuredEnabled: false, enablementOrigin: "owner_configuration", route: { providerId: "opencode", modelId: route.modelId } }] as never;
    const signal = AbortSignal.timeout(1000);
    expect((await run.service.discover(signal)).routes).toEqual([]);
    run.settings.harnesses = [];
    run.generate.mockImplementationOnce(async ({ revalidate }) => {
      run.canonical.nativeHarnessCatalog!.profiles = [];
      expect(await revalidate()).toBe(false);
      throw new Error("Grant revoked");
    });
    await expect(run.service.generate({ route, prompt, signal })).rejects.toThrow("Grant revoked");
  });

  it("keeps unverifiable runtimes and canonically failed catalog rows unavailable", async () => {
    const run = fixture();
    const signal = AbortSignal.timeout(1000);
    run.probe.mockResolvedValueOnce(false);
    expect((await run.service.discover(signal)).routes).toEqual([]);
    run.canonical.nativeHarnessCatalog!.failures = ["opencode"];
    expect((await run.service.discover(signal)).routes).toEqual([]);
  });
});
