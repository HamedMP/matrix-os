import { describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { createChatProviderCatalogService, ProviderCatalogUnavailableError, type CodingModelCatalogProjection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createCodexModelCatalogSource } from "../../packages/gateway/src/chat/codex-model-catalog.js";

function provider(kind: "codex" | "opencode" | "pi"): AgentProviderSummary {
  return { id: kind, kind, displayName: kind, availability: "available", installStatus: "installed", authStatus: "authenticated",
    supportedModes: ["default"], defaultMode: "default", defaultModel: "model", setupActions: [] };
}
function models(id: string): CodingModelCatalogProjection {
  return { models: [{ id, displayName: id, capabilities: ["tools"], supportsToolUse: true, supportsVision: false }], options: [], defaultModel: id };
}
function service(providers: AgentProviderSummary[], source: (provider: AgentProviderSummary) => Promise<CodingModelCatalogProjection | null>) {
  return createChatProviderCatalogService({ codingProviders: { listProviders: async () => providers, invalidate() {} },
    agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null }, providers: [],
      messaging: { runtime: "hermes", provider: null, model: null, configured: false } }), codingModelCatalogSource: source,
    credentialedDriverKinds: ["pi", "opencode"] });
}

describe("bounded parallel coding model discovery", () => {
  it("starts all probes before any settles and keeps provider results in deterministic order", async () => {
    const providers = [provider("codex"), provider("opencode"), provider("pi")];
    const resolve: Array<(value: CodingModelCatalogProjection) => void> = [];
    const responses = providers.map(() => new Promise<CodingModelCatalogProjection>((done) => { resolve.push(done); }));
    const source = vi.fn((entry: AgentProviderSummary) => responses[providers.indexOf(entry)]!);
    const request = service(providers, source).getCatalog({ userId: "owner", source: "jwt" });
    try { await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(3), { timeout: 100 }); }
    finally { for (let index = resolve.length - 1; index >= 0; index--) resolve[index]!(models(`model-${index}`)); }
    const catalog = await request;
    expect(catalog.instances.filter((entry) => providers.some((candidate) => candidate.kind === entry.driverKind))
      .map((entry) => [entry.driverKind, entry.models[0]?.id])).toEqual([["codex", "model-0"], ["opencode", "model-1"], ["pi", "model-2"]]);
  });
  it("isolates one failed probe without hiding the other ready models or leaking its error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const catalog = await service([provider("codex"), provider("pi")], async (entry) => {
        if (entry.kind === "codex") throw new Error("private CLI failure");
        return models("pi-model");
      }).getCatalog({ userId: "owner", source: "jwt" });
      expect(catalog.instances.find((entry) => entry.driverKind === "pi")?.models[0]?.id).toBe("pi-model");
      expect(warning).toHaveBeenCalledWith("[chat-providers] Coding model catalog unavailable");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private CLI failure");
    } finally { warning.mockRestore(); }
  });
  it("still rejects duplicate drivers after concurrent projection", async () => {
    await expect(service([provider("codex"), provider("codex")], async () => models("model"))
      .getCatalog({ userId: "owner", source: "jwt" })).rejects.toBeInstanceOf(ProviderCatalogUnavailableError);
  });
  it.each(["auth_required", "setup_required", "unavailable"] as const)("does not launch Codex model discovery when %s", async (availability) => {
    const spawnProcess = vi.fn(() => { throw new Error("Must not spawn"); });
    const source = createCodexModelCatalogSource({ executable: "codex", cwd: "/tmp", spawnProcess });
    await expect(source({ ...provider("codex"), availability })).resolves.toBeNull();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
