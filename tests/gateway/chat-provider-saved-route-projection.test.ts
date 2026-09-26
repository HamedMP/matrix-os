import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSource } from "../../packages/gateway/src/agent-config/service.js";
import {
  ProviderSettingsConfigurationSchema,
  writeProviderJsonAtomic,
} from "../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import type { CodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import { PROVIDER_SETTINGS_NOW, providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

type Harness = "pi" | "opencode";

function codingRegistry(kind: Harness, installed = true): CodingAgentProviderRegistry {
  const provider: AgentProviderSummary = {
    id: kind, displayName: kind === "pi" ? "Pi" : "OpenCode", kind,
    availability: installed ? "available" : "setup_required",
    installStatus: installed ? "installed" : "missing", authStatus: "authenticated",
    supportedModes: ["default"], defaultMode: "default", defaultModel: "claude-sonnet-5",
    setupActions: [],
  };
  return { listProviders: async () => [provider], invalidate: () => {} };
}

const runtimeSource: AgentRuntimeSource = async () => ({
  runtime: { selected: "hermes", options: [], transition: null },
  providers: [],
  messaging: { runtime: "hermes", provider: null, model: null, configured: false },
});

describe("saved harness intent through Settings projection and Chat catalog", () => {
  it.each([
    ["pi", "retired", false, true], ["pi", "unavailable", false, true],
    ["opencode", "retired", false, true], ["opencode", "unavailable", false, true],
    ["pi", "retired", true, true], ["opencode", "unavailable", true, true],
    ["pi", "retired", false, false],
  ] as const)("keeps %s saved intent when its selected model is %s (enabled=%s, installed=%s)", async (kind, modelStatus, enabled, installed) => {
    const homePath = await mkdtemp(join(tmpdir(), "saved-harness-route-"));
    try {
      const canonical = providerSettingsCanonicalFixture();
      canonical.drivers.push({
        id: kind, displayName: kind === "pi" ? "Pi" : "OpenCode", kind: "cli",
        installState: installed ? "installed" : "missing", health: "ready", capabilities: ["tools", "resume"],
        setupActions: [],
      });
      canonical.models.find((model) => model.id === "claude-sonnet-5")!.status = modelStatus;
      await writeProviderJsonAtomic(join(homePath, "system/ai-providers/settings.json"), {
        schemaVersion: 1, revision: 1, accountProfiles: [], gatewayPolicy: null, receipts: [],
        harnesses: [{
          id: `harness_${kind}`, driverId: kind, harness: kind,
          displayName: kind === "pi" ? "Pi" : "OpenCode", accentColor: null,
          enabled, selectedAccountId: "owner_anthropic", accessSourceId: "owner_anthropic_profile",
          route: { kind: "configurable", providerId: "anthropic", modelId: "claude-sonnet-5" },
        }],
      });
      const store = new ProviderSettingsStore({
        homePath, providerSnapshotReader: { getSnapshot: async () => canonical },
        now: () => PROVIDER_SETTINGS_NOW,
      });
      const settings = await store.getSnapshot();
      expect.soft(settings.harnesses.find((harness) => harness.harness === kind)).toMatchObject({
        configuredEnabled: enabled, enabled: false, routeAvailability: "catalog_unavailable",
        connectivity: "offline", authState: "unknown", accessSourceId: null, selectedAccountId: null,
      });
      expect(settings.modelProviders.find((provider) => provider.id === "anthropic")?.models.find((model) => (
        model.id === "claude-sonnet-5"
      ))?.enabled).toBe(false);
      expect(ProviderSettingsConfigurationSchema.parse(JSON.parse(await readFile(
        join(homePath, "system/ai-providers/settings.json"), "utf8",
      ))).harnesses[0]?.enabled).toBe(enabled);
      const catalog = createChatProviderCatalogService({
        codingProviders: codingRegistry(kind, installed), agentRuntimeSource: runtimeSource,
        harnessSettingsSource: store, executableDriverKinds: [kind], credentialedDriverKinds: [kind],
      });
      const instance = (await catalog.getCatalog({ userId: "owner_1", source: "jwt" })).instances.find((candidate) => (
        candidate.id === `${kind}_default`
      ));
      expect(instance).toMatchObject({
        availability: "unavailable",
        unavailabilityReason: !installed ? "not_installed"
          : enabled ? "runtime_unavailable" : "disabled_in_settings",
        models: [], defaultSelection: undefined,
      });
      if (installed) expect(instance?.setupActions).toEqual([]);
      else expect(instance?.setupActions.some((action) => action.id === `${kind}_install`)).toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
