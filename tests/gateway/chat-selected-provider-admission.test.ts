import { describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createChatProviderCatalogService, ProviderCatalogUnavailableError, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";

const principal = { userId: "owner_selected", source: "jwt" as const };
const selected = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
const now = new Date("2026-08-29T21:00:00Z");
const runtime = { runtime: { selected: "hermes" as const, options: [], transition: null }, providers: [],
  messaging: { runtime: "hermes" as const, provider: null, model: null, configured: false } };
const codex: AgentProviderSummary = { id: "codex", kind: "codex", displayName: "Codex", availability: "available",
  installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default",
  defaultModel: "codex-model", setupActions: [] };

function sources() {
  return { codingProviders: { listProviders: vi.fn(async () => [codex]), invalidate: vi.fn() },
    agentRuntimeSource: vi.fn(async () => runtime), aiProviderSource: { getSnapshot: vi.fn(async () => makeAiProviderSnapshot()) },
    codingModelCatalogSource: vi.fn(async () => null), now: () => now, executableDriverKinds: ["matrix_pi", "codex"] as const };
}

describe("selected Provider admission discovery", () => {
  it("does not start or wait for unrelated coding/system inventory for Matrix AI", async () => {
    const input = sources();
    const held = Promise.withResolvers<AgentProviderSummary[]>();
    input.codingProviders.listProviders.mockImplementation(() => held.promise);
    const service = createChatProviderCatalogService(input);
    const request = service.getCatalog(principal, selected);
    try {
      const result = await Promise.race([request, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
      expect(result).not.toBeNull();
      expect(result!.instances.map(instance => instance.id)).toEqual([selected.instanceId]);
      expect(validateChatProviderSelection({ catalog: result!, selection: selected }).ok).toBe(true);
      expect(validateChatProviderSelection({ catalog: result!, selection: selected, requirements: { permissionMode: "read_only" } }).ok).toBe(false);
      expect(validateChatProviderSelection({ catalog: result!, selection: { ...selected, options: [{ id: "forged", value: true }] } }).ok).toBe(false);
      expect(input.codingProviders.listProviders).not.toHaveBeenCalled();
      expect(input.agentRuntimeSource).not.toHaveBeenCalled();
      expect(input.codingModelCatalogSource).not.toHaveBeenCalled();
      expect(input.aiProviderSource.getSnapshot).toHaveBeenCalledWith({ refresh: false, admissionScope: "managed_matrix" });
    } finally { held.resolve([]); await request; }
  });

  it("rechecks current selected funding and retired/model policy instead of reusing picker truth", async () => {
    const input = sources(); const snapshot = makeAiProviderSnapshot();
    input.aiProviderSource.getSnapshot.mockImplementation(async () => structuredClone(snapshot));
    const service = createChatProviderCatalogService(input);
    expect(validateChatProviderSelection({ catalog: await service.getCatalog(principal, selected), selection: selected }).ok).toBe(true);
    snapshot.accessSources[0]!.state = "unavailable";
    expect(validateChatProviderSelection({ catalog: await service.getCatalog(principal, selected), selection: selected }).ok).toBe(false);
    snapshot.accessSources[0]!.state = "ready"; snapshot.models[0]!.status = "retired";
    expect(validateChatProviderSelection({ catalog: await service.getCatalog(principal, selected), selection: selected }).ok).toBe(false);
    snapshot.models[0]!.status = "current"; snapshot.accessSources[0]!.eligibleModelIds = [];
    expect(validateChatProviderSelection({ catalog: await service.getCatalog(principal, selected), selection: selected }).ok).toBe(false);
    expect(input.aiProviderSource.getSnapshot).toHaveBeenCalledTimes(4);
  });

  it("fails selected admission closed when required Settings cannot be read", async () => {
    const service = createChatProviderCatalogService({ ...sources(), harnessSettingsSource: {
      getSnapshot: async () => { throw new Error("private settings failure"); },
    } });
    await expect(service.getCatalog(principal, selected)).rejects.toBeInstanceOf(ProviderCatalogUnavailableError);
  });

  it("rejects invented or retired SDK instance ids without triggering other discovery", async () => {
    const input = sources(); const service = createChatProviderCatalogService(input);
    for (const instanceId of ["codex_invented", "kernel_matrix_included"]) {
      const selection = { ...selected, instanceId };
      expect(validateChatProviderSelection({ catalog: await service.getCatalog(principal, selection), selection }).ok).toBe(false);
    }
    expect(input.codingProviders.listProviders).not.toHaveBeenCalled();
    expect(input.aiProviderSource.getSnapshot).not.toHaveBeenCalled();
  });

  it("reads only the selected system runtime and keeps its model validation authoritative", async () => {
    const input = sources();
    const hermes = vi.fn(async () => ({ ...runtime,
      runtime: { ...runtime.runtime, options: [{ id: "hermes" as const, displayName: "Hermes", installState: "installed" as const,
        health: "healthy" as const, selectionState: "active" as const, configured: true, capabilities: [] }] },
      providers: [{ id: "anthropic", displayName: "Anthropic", runtime: "hermes" as const, scopes: ["messaging" as const],
        authKind: "api_key" as const, supportedAuthKinds: ["api_key" as const],
        authStatus: { state: "ready" as const, authenticated: true, action: "none" as const },
        models: [{ id: "system-model", displayName: "System model", capabilities: ["tools" as const], efforts: [], available: true }] }],
      messaging: { runtime: "hermes" as const, provider: "anthropic", model: "system-model", configured: true } }));
    const openclaw = vi.fn(async () => runtime);
    const service = createChatProviderCatalogService({ ...input, executableDriverKinds: ["hermes"],
      systemRuntimeSources: { hermes, openclaw } });
    const selection = { instanceId: "hermes_default", model: "anthropic:system-model" };
    const catalog = await service.getCatalog(principal, selection);
    expect(validateChatProviderSelection({ catalog, selection }).ok).toBe(true);
    expect(validateChatProviderSelection({ catalog, selection: { ...selection, model: "anthropic:invented" } }).ok).toBe(false);
    expect(openclaw).not.toHaveBeenCalled(); expect(hermes).toHaveBeenCalledOnce();
    expect(input.codingProviders.listProviders).not.toHaveBeenCalled();
    expect(catalog.instances.map(instance => instance.id)).toEqual([selection.instanceId]);
  });

  it("discovers only the selected coding model inventory and retains the complete picker", async () => {
    const input = sources();
    input.codingProviders.listProviders.mockResolvedValue([codex, { ...codex, id: "pi", kind: "pi" }]);
    const service = createChatProviderCatalogService(input);
    const catalog = await service.getCatalog(principal, { instanceId: "codex_default", model: "codex-model" });
    expect(catalog.instances.map(instance => instance.id)).toEqual(["codex_default"]);
    expect(input.codingModelCatalogSource).toHaveBeenCalledTimes(1);
    expect(input.codingModelCatalogSource).toHaveBeenCalledWith(codex, principal);
    expect(input.agentRuntimeSource).not.toHaveBeenCalled();
    input.codingModelCatalogSource.mockClear();
    const picker = await service.getCatalog(principal);
    expect(picker.instances.map(instance => instance.id)).toEqual(expect.arrayContaining(["matrix_pi_default", "codex_default", "pi_default", "hermes_default", "openclaw_default"]));
    expect(input.codingModelCatalogSource).toHaveBeenCalledTimes(2);
    expect(input.agentRuntimeSource).toHaveBeenCalledOnce();
    expect(catalog.revision).not.toBe(picker.revision);
    expect(catalog.instances.every(instance => instance.catalogRevision === catalog.revision)).toBe(true);
  });
});
