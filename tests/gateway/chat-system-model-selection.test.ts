import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { systemModels } from "../../packages/gateway/src/chat/system-model-catalog.js";

const now = new Date("2026-09-28T00:00:00Z");
const principal = { userId: "test_owner", source: "jwt" as const };

function native() {
  return normalizeHermesRuntimeSnapshot({
    observedAt: +now,
    status: { gateway_running: true },
    options: {
      provider: "openai-codex", model: "model-0",
      providers: ["copilot", "openai-codex"].map(slug => ({
        slug, name: slug, authenticated: true, auth_type: "oauth",
        models: Array.from({ length: 60 }, (_, index) => `model-${index}`),
      })),
    },
  });
}

describe("selected models in a bounded system inventory", () => {
  it.each(["hermes", "openclaw"] as const)("retains %s's configured default beyond its provider quota", async kind => {
    const snapshot = native();
    snapshot.runtime.selected = kind;
    snapshot.runtime.options = [{ ...snapshot.runtime.options[0]!, id: kind, selectionState: "active" }];
    snapshot.providers = snapshot.providers.map(provider => ({ ...provider, runtime: kind }));
    snapshot.messaging = { runtime: kind, provider: "openai-codex", model: "model-59", configured: true };
    const service = createChatProviderCatalogService({
      codingProviders: { listProviders: async () => [], invalidate: () => {} },
      agentRuntimeSource: async () => snapshot,
    });
    const instance = (await service.getCatalog(principal)).instances.find(row => row.driverKind === kind)!;
    expect(instance.models).toHaveLength(64);
    expect(instance.defaultSelection?.model).toBe("openai-codex:model-59");
  });

  it("preserves a different saved native Hermes selection through Settings admission", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "bounded-hermes-selection-"));
    const snapshot = native();
    const producer = new AiProviderService({
      homePath, env: {}, now: () => now,
      nativeHarnessCatalogReader: { getCatalog: async () => ({ providers: [], accessSources: [], failures: [] }) },
      hermesRuntimeSource: async () => snapshot,
      driverInventory: async () => [{ id: "hermes", displayName: "Hermes", kind: "cli", installState: "installed",
        health: "ready", capabilities: ["tools"], setupActions: [] }],
    });
    try {
      const store = new ProviderSettingsStore({ homePath, now: () => now, providerSnapshotReader: producer });
      const settings = await store.getSnapshot();
      settings.harnesses.find(row => row.harness === "hermes")!.route.modelId = "openai-codex:model-59";
      const service = createChatProviderCatalogService({
        now: () => now, codingProviders: { listProviders: async () => [], invalidate: () => {} },
        agentRuntimeSource: async () => snapshot, aiProviderSource: producer,
        harnessSettingsSource: { getSnapshot: async () => settings }, executableDriverKinds: ["hermes"],
      });
      const instance = (await service.getCatalog(principal)).instances.find(row => row.driverKind === "hermes")!;
      expect(instance.availability).toBe("available");
      expect(instance.defaultSelection?.model).toBe("openai-codex:model-59");
      expect(instance.models.some(model => model.id === "openai-codex:model-0")).toBe(true);
      expect(instance.models.length).toBeLessThanOrEqual(64);
    } finally {
      producer.close();
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("does not manufacture a preferred model absent from eligible runtime inventory", () => {
    const snapshot = native();
    snapshot.providers.find(provider => provider.id === "openai-codex")!.models.find(model => model.id === "model-59")!.available = false;
    const models = systemModels("hermes", snapshot.providers, ["openai-codex:model-59", "missing:model"]);
    expect(models).toHaveLength(64);
    expect(models.some(model => model.id === "openai-codex:model-59" || model.id === "missing:model")).toBe(false);
  });
});
