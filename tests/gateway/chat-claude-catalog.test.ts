import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import { buildAgentLaunch } from "../../packages/gateway/src/agent-launcher.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createClaudeModelCatalogSource } from "../../packages/gateway/src/chat/claude-model-catalog.js";
import { EventEmitter } from "node:events";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const principal = { userId: "owner_catalog", source: "jwt" as const };
const provider: AgentProviderSummary = {
  id: "claude", kind: "claude", displayName: "Claude Code", availability: "available",
  installStatus: "installed", authStatus: "authenticated", supportedModes: ["default", "review"],
  defaultMode: "default", setupActions: [],
};

function catalogService(overrides: Partial<Parameters<typeof createChatProviderCatalogService>[0]> = {}) {
  return createChatProviderCatalogService({
    codingProviders: { listProviders: async () => [provider], invalidate() {} },
    agentRuntimeSource: async () => ({
      runtime: { selected: "hermes", options: [], transition: null }, providers: [],
      messaging: { runtime: "hermes", provider: null, model: null, configured: false },
    }),
    executableDriverKinds: ["claude_code"],
    ...overrides,
  });
}

describe("Claude catalog selection and CLI handoff", () => {
  afterEach(() => vi.useRealTimers());
  it("admits the runtime's resolved Fable ID unchanged without claiming its context qualifier", async () => {
    const source = createClaudeModelCatalogSource({ discover: async () => [
      { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
      { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)" },
      { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ] });
    const catalog = await catalogService({ codingModelCatalogSource: source }).getCatalog(principal);
    const instance = catalog.instances.find((entry) => entry.id === "claude_code_default")!;
    expect(instance.defaultSelection?.model).toBe("default");
    expect(instance.models.map((model) => model.id)).not.toContain("claude-fable-5-1");
    for (const model of ["claude-fable-5", "default", "opus", "sonnet"]) {
      const admitted = validateChatProviderSelection({
        catalog, boundInstanceId: "claude_code_default",
        selection: { instanceId: "claude_code_default", model },
      });
      expect(admitted.ok, model).toBe(true);
      if (!admitted.ok) throw new Error("Model rejected");
      const launch = buildAgentLaunch({
        agent: "claude", cwd: "/workspace", runtimeHome: "/runtime-home", prompt: "Read only",
        model: admitted.selection.model, mode: "default", approvalPolicy: "on-request",
        sandbox: { enabled: true, mode: "workspace-write", writableRoots: ["/workspace"] },
        claudeOutputFormat: "stream-json", claudeIncludePartialMessages: true,
      });
      expect(launch.args[launch.args.indexOf("--model") + 1]).toBe(model);
      expect(launch.args).toContain("--include-partial-messages");
      expect(launch.args).toContain("--strict-mcp-config");
    }
    expect(validateChatProviderSelection({ catalog, selection: {
      instanceId: "claude_code_default", model: "claude-unadvertised",
    } })).toMatchObject({ ok: false, error: { code: "model_unavailable", retryable: false } });
  });

  it("refreshes discovered models without replacing a valid selection and retains last good data on failure", async () => {
    let models: unknown = [{ value: "claude-fable-5", displayName: "Claude Fable 5" }];
    let requests = 0;
    const source = createClaudeModelCatalogSource({ discover: async () => {
      requests++;
      if (models instanceof Error) throw models;
      return models;
    } });
    const service = catalogService({ codingModelCatalogSource: source, invalidateCodingModelCatalog: source.invalidate });
    const first = await service.getCatalog(principal);
    models = [{ value: "claude-fable-5", displayName: "Claude Fable 5" },
      { value: "claude-fable-5-1", displayName: "Claude Fable 5.1" }];
    expect((await service.getCatalog(principal)).revision).toBe(first.revision);
    expect(requests).toBe(1);
    const refreshed = await service.refresh(principal);
    expect(refreshed.revision).not.toBe(first.revision);
    expect(validateChatProviderSelection({ catalog: refreshed, selection: {
      instanceId: "claude_code_default", model: "claude-fable-5",
    } })).toMatchObject({ ok: true, selection: { model: "claude-fable-5" } });
    models = new Error("secret upstream failure");
    expect((await service.refresh(principal)).revision).toBe(refreshed.revision);
  });

  it("coalesces concurrent discovery and bounds a hung inventory read before falling back", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const signals: AbortSignal[] = [];
    const source = createClaudeModelCatalogSource({ timeoutMs: 50, discover: async (signal) => {
      requests++;
      signals.push(signal);
      return new Promise(() => {});
    } });
    const service = catalogService({ codingModelCatalogSource: source });
    const first = service.getCatalog(principal);
    const second = service.getCatalog(principal);
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toBe(1);
    const results = await Promise.all([first, second]);
    expect(signals[0]?.aborted).toBe(true);
    expect(results[0].instances.find((entry) => entry.id === "claude_code_default")?.models.map((entry) => entry.id))
      .toEqual(["default", "opus", "sonnet"]);
  });

  it("never reuses an inventory across owners or changed credential contexts", async () => {
    let context = "credential_generation_one";
    const source = createClaudeModelCatalogSource({
      discover: async () => [{ value: "claude-fable-5", displayName: "Fable" }],
      resolveContext: async () => ({ key: context, discover: async () => {
        if (context !== "credential_generation_one") throw new Error("private account detail");
        return [{ value: "claude-fable-5", displayName: "Fable" }];
      } }),
    });
    const service = catalogService({ codingModelCatalogSource: source });
    expect((await service.getCatalog(principal)).instances.find((entry) => entry.id === "claude_code_default")?.models
      .some((entry) => entry.id === "claude-fable-5")).toBe(true);
    context = "credential_generation_two";
    for (const ownerId of [principal.userId, "another_owner"]) {
      const catalog = await service.getCatalog({ ...principal, userId: ownerId });
      expect(catalog.instances.find((entry) => entry.id === "claude_code_default")?.models.map((entry) => entry.id))
        .toEqual(["default", "opus", "sonnet"]);
    }
  });

  it("fails closed on explicit profile refresh when credential generation cannot be verified", async () => {
    let available = true;
    const source = createClaudeModelCatalogSource({ resolveContext: async () => ({
      key: "owner_profile", retainOnRefresh: false, maxAgeMs: 5_000,
      discover: async () => {
        if (!available) throw new Error("private upstream detail");
        return [{ value: "claude-fable-5", displayName: "Fable" }];
      },
    }) });
    const service = catalogService({ codingModelCatalogSource: source, invalidateCodingModelCatalog: source.invalidate });
    await service.getCatalog(principal);
    available = false;
    expect((await service.refresh(principal)).instances.find((entry) => entry.id === "claude_code_default")?.models
      .map((entry) => entry.id)).toEqual(["default", "opus", "sonnet"]);
  });

  it("persists an admitted Fable selection and passes it unchanged on the resumed native session", async () => {
    const database = await KyselyPGlite.create();
    const repository = new ChatRepository(database.dialect);
    const owner = { type: "personal" as const, ownerId: principal.userId };
    const launches: string[][] = [];
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/runtime-home", resolveCredentialEnv: async () => ({}),
      spawnFn: (_command, args) => {
        launches.push([...args]);
        const child = Object.assign(new EventEmitter(), {
      stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
          stdout: new EventEmitter(), stderr: new EventEmitter(),
          kill(signal: NodeJS.Signals) { this.emit("exit", null, signal); },
        });
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from([
            JSON.stringify({ type: "system", subtype: "init", session_id: "session_catalog", model: "claude-fable-5" }),
            JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done" }), "",
          ].join("\n")));
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    const source = createClaudeModelCatalogSource({ discover: async () => [
      { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
    ] });
    const orchestrator = new CanonicalChatOrchestrator({ repository,
      catalog: catalogService({ codingModelCatalogSource: source }),
      adapters: new CanonicalChatProviderRegistry([adapter]),
    });
    try {
      await repository.bootstrap();
      await repository.create(owner, { id: "chat_catalog", clientRequestId: "req_create_catalog", title: "Catalog" });
      for (let turn = 0; turn < 2; turn++) {
        const chat = await repository.get(owner, "chat_catalog");
        const selection = chat?.chat.currentSelection ?? { instanceId: "claude_code_default", model: "claude-fable-5" };
        const admitted = await orchestrator.admitTurn(principal, owner, "chat_catalog", {
          clientRequestId: `req_catalog_turn_${turn}`, baseRevision: chat!.chat.revision,
          parts: [{ type: "text", text: "Read only" }], selection,
          interactionMode: "default", permissionMode: "supervised",
        });
        expect(admitted.admission).toBe("accepted");
        await orchestrator.drain();
        expect((await repository.get(owner, "chat_catalog"))?.chat.currentSelection)
          .toMatchObject({ instanceId: "claude_code_default", model: "claude-fable-5" });
      }
      expect(launches).toHaveLength(2);
      for (const args of launches) expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5");
      expect(launches[1]![launches[1]!.indexOf("--resume") + 1]).toBe("session_catalog");
    } finally {
      await orchestrator.drain();
      await repository.kysely.destroy();
    }
  });

  it.each([
    { label: "empty", inventory: [] },
    { label: "oversized", inventory: Array.from({ length: 65 }, (_, index) => ({ value: `model-${index}`, displayName: "Model" })) },
    { label: "unsafe", inventory: [{ value: "claude-fable-5", displayName: "private\nraw output" }] },
  ])("falls back safely for $label runtime metadata", async ({ inventory }) => {
    const source = createClaudeModelCatalogSource({ discover: async () => inventory });
    const result = await catalogService({ codingModelCatalogSource: source }).getCatalog(principal);
    expect(result.instances.find((entry) => entry.id === "claude_code_default")?.models.map((entry) => entry.id))
      .toEqual(["default", "opus", "sonnet"]);
  });

  it("expires last-good data and deduplicates metadata without leaking stale account models", async () => {
    vi.useFakeTimers();
    let fail = false;
    const source = createClaudeModelCatalogSource({ cacheTtlMs: 10, discover: async () => {
      if (fail) throw new Error("private failure");
      return [{ value: "claude-fable-5", displayName: "Fable" }, { value: "claude-fable-5", displayName: "Fable duplicate" }];
    } });
    const service = catalogService({ codingModelCatalogSource: source });
    const first = await service.getCatalog(principal);
    expect(first.instances.find((entry) => entry.id === "claude_code_default")?.models
      .filter((entry) => entry.id === "claude-fable-5")).toHaveLength(1);
    fail = true;
    await vi.advanceTimersByTimeAsync(300_001);
    expect((await service.getCatalog(principal)).instances.find((entry) => entry.id === "claude_code_default")?.models
      .map((entry) => entry.id)).toEqual(["default", "opus", "sonnet"]);
  });

  it("keeps the complete projected inventory within the public catalog limit", async () => {
    const source = createClaudeModelCatalogSource({ discover: async () => Array.from({ length: 64 }, (_, index) => ({
      value: `claude-model-${index}`, displayName: `Model ${index}`,
    })) });
    const catalog = await catalogService({ codingModelCatalogSource: source }).getCatalog(principal);
    expect(catalog.instances.find((entry) => entry.id === "claude_code_default")?.models).toHaveLength(64);
  });

  it("evicts old owner inventories instead of retaining an unbounded model cache", async () => {
    let requests = 0;
    const source = createClaudeModelCatalogSource({ discover: async () => [{
      value: `claude-model-${++requests}`, displayName: "Model",
    }] });
    const service = catalogService({ codingModelCatalogSource: source });
    for (let owner = 0; owner < 33; owner++) await service.getCatalog({ ...principal, userId: `owner_${owner}` });
    const reloaded = await service.getCatalog({ ...principal, userId: "owner_0" });
    expect(reloaded.instances.find((entry) => entry.id === "claude_code_default")?.models
      .some((entry) => entry.id === "claude-model-34")).toBe(true);
  });

  it("does not resurrect a profile inventory invalidated while discovery was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const source = createClaudeModelCatalogSource({ resolveContext: async () => ({
      key: "profile", retainOnRefresh: false, discover: async () => {
        if (++reads > 1) throw new Error("metadata unavailable");
        await gate;
        return [{ value: "claude-fable-5", displayName: "Fable" }];
      },
    }) });
    const service = catalogService({ codingModelCatalogSource: source, invalidateCodingModelCatalog: source.invalidate });
    const first = service.getCatalog(principal);
    await vi.waitFor(() => expect(reads).toBe(1));
    const refreshed = service.refresh(principal);
    release();
    await first;
    expect((await refreshed).instances.find((entry) => entry.id === "claude_code_default")?.models
      .map((entry) => entry.id)).toEqual(["default", "opus", "sonnet"]);
  });
});
