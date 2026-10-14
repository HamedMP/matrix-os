import { describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { AgentRuntimeSettingsSnapshot } from "../../packages/gateway/src/agent-config/service.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";

const principal = { userId: "owner_1", source: "jwt" as const };
const bareModel = "claude-haiku-4-5-20251001";
const model = `anthropic:${bareModel}`;
const codex: AgentProviderSummary = {
  id: "codex", kind: "codex", displayName: "Codex", availability: "available",
  installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"],
  defaultMode: "default", defaultModel: "gpt-test", setupActions: [],
};

function fixture(evidence: "fresh" | "expired" | "future" = "fresh") {
  let clock = Date.parse("2026-10-14T18:00:00Z");
  const calls: string[] = [];
  const observation = () => ({ state: "present_unverified" as const,
    checkedAt: new Date(clock + (evidence === "future" ? 1000 : 0)).toISOString(),
    staleAfter: new Date(clock + (evidence === "expired" ? 0 : 5000)).toISOString() });
  const runtime = vi.fn(async (): Promise<AgentRuntimeSettingsSnapshot> => {
    calls.push("native");
    return {
      runtime: { selected: "hermes", transition: null, options: [{ id: "hermes", displayName: "Hermes",
        installState: "installed", health: "healthy", selectionState: "active", configured: true,
        capabilities: ["provider_catalog"] }] },
      providers: [{ id: "anthropic", displayName: "Anthropic", runtime: "hermes", scopes: ["messaging"],
        authKind: "api_key", supportedAuthKinds: ["api_key"],
        authStatus: { state: "ready", authenticated: true, action: "none" },
        models: [{ id: bareModel, displayName: "Haiku", available: true, capabilities: ["tools"], efforts: [] }] }],
      messaging: { runtime: "hermes", provider: "anthropic", model: bareModel, configured: true },
    };
  });
  const settings = vi.fn(async (): Promise<ProviderSettingsSnapshot> => {
    calls.push("settings");
    return {
      contractVersion: 1, projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision: "test" },
      revision: 1, refreshedAt: new Date(clock).toISOString(), access: { mode: "writable" },
      supportedActions: [], harnessCatalog: [], modelProviders: [], accounts: [], gatewayPolicy: null,
      harnesses: [{ id: "harness_hermes", harness: "hermes", displayName: "Hermes", accentColor: null,
        enabled: true, configuredEnabled: true, version: null, installState: "installed", authState: "unknown",
        loginMethods: ["terminal"], recommendedLoginMethod: "terminal", connectivity: "unknown", accountIds: [],
        selectedAccountId: null, accessSourceId: "harness_hermes_anthropic", activeChatCount: 0,
        route: { kind: "configurable", providerId: "anthropic", modelId: model } }],
      accessSources: [{ id: "harness_hermes_anthropic", kind: "harness_profile", fundingKind: "owner_account",
        harness: "hermes", providerId: "anthropic", accountId: null, displayName: "Hermes account",
        eligibleModelIds: [model], localObservation: observation(),
        readiness: { state: "unknown", checkedAt: null, staleAfter: null, action: "retry", safeReason: "unknown" },
        usage: { kind: "unavailable", authority: "unavailable", state: "not_applicable", scope: "access_source",
          reason: "provider_does_not_report", asOf: null } }],
    };
  });
  const codingModels = vi.fn(async () => { calls.push("coding"); clock += 7000; return null; });
  const service = createChatProviderCatalogService({
    codingProviders: { listProviders: vi.fn(async () => [codex]), invalidate: vi.fn() },
    codingModelCatalogSource: codingModels, agentRuntimeSource: runtime,
    systemRuntimeSources: { hermes: runtime }, harnessSettingsSource: { getSnapshot: settings },
    executableDriverKinds: ["hermes", "codex"], now: () => new Date(clock),
  });
  return { service, calls, codingModels, settings };
}

describe("native Chat catalog freshness after coding discovery", () => {
  it("keeps Hermes runnable after unrelated coding discovery outlasts its five-second evidence", async () => {
    const { service, calls, settings } = fixture();
    const result = await service.getCatalog(principal);
    expect(result.instances.find(row => row.id === "hermes_default")).toMatchObject({
      availability: "available", defaultSelection: { instanceId: "hermes_default", model },
    });
    expect(calls.indexOf("coding")).toBeLessThan(calls.indexOf("native"));
    expect(calls.indexOf("coding")).toBeLessThan(calls.indexOf("settings"));
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "future"] as const)("still refuses %s native evidence using the current clock", async evidence => {
    const { service } = fixture(evidence);
    expect((await service.getCatalog(principal)).instances.find(row => row.id === "hermes_default"))
      .toMatchObject({ availability: "unavailable", unavailabilityReason: "runtime_not_runnable", models: [] });
  });

  it("does not discover unrelated coding harnesses for a selected Hermes run", async () => {
    const { service, codingModels } = fixture();
    const result = await service.getCatalog(principal, { instanceId: "hermes_default", model });
    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]?.availability).toBe("available");
    expect(codingModels).not.toHaveBeenCalled();
  });
});
