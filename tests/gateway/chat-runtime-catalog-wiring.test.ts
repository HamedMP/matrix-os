import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";

const mocks = vi.hoisted(() => ({
  claude: Object.assign(vi.fn(), { invalidate: vi.fn() }),
  codex: vi.fn(), native: vi.fn(), credentials: vi.fn(), skills: vi.fn(),
  createClaude: vi.fn(), createCodex: vi.fn(), createNative: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock("../../packages/gateway/src/chat/claude-runtime-model-catalog.js", () => ({
  createRuntimeClaudeModelCatalogSource: mocks.createClaude,
}));
vi.mock("../../packages/gateway/src/chat/codex-model-catalog.js", () => ({
  createCodexModelCatalogSource: mocks.createCodex,
}));
vi.mock("../../packages/gateway/src/chat/native-coding-model-catalog.js", () => ({
  createNativeCodingModelCatalogSource: mocks.createNative,
}));
vi.mock("../../packages/gateway/src/chat/provider-catalog.js", () => ({
  createChatProviderCatalogService: mocks.catalog,
}));
vi.mock("../../packages/gateway/src/kernel-credentials.js", () => ({
  buildKernelCredentialLaunch: mocks.credentials,
}));
vi.mock("@matrix-os/kernel", () => ({ loadSkills: mocks.skills }));

import { createGatewayChatProviderCatalog } from "../../packages/gateway/src/chat/runtime-provider-catalog.js";

type CatalogOptions = Parameters<typeof createChatProviderCatalogService>[0];
const principal = { userId: "owner_catalog_wiring", source: "jwt" as const };
const provider = { id: "claude", kind: "claude", availability: "available" } as never;
const projection = { models: [], options: [], defaultModel: "synthetic-model" };
const dependencies = {
  codingProviders: { listProviders: vi.fn(), invalidate: vi.fn() },
  agentRuntimeSource: {} as CatalogOptions["agentRuntimeSource"],
  executableDriverKinds: ["codex", "claude_code"] as const,
};

function compose(codexExecutable?: string) {
  const result = createGatewayChatProviderCatalog({
    ...dependencies, homePath: "/runtime-home", codexExecutable,
  });
  const options = mocks.catalog.mock.calls[0][0] as CatalogOptions;
  return { ...result, options, source: options.codingModelCatalogSource! };
}

describe("gateway Chat runtime catalog composition", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createClaude.mockReturnValue(mocks.claude);
    mocks.createCodex.mockReturnValue(mocks.codex);
    mocks.createNative.mockReturnValue(mocks.native);
    mocks.claude.mockResolvedValue(null);
    mocks.codex.mockResolvedValue(null);
    mocks.native.mockResolvedValue(null);
  });

  it("shares the execution credential factory with metadata discovery and preserves service dependencies", async () => {
    vi.stubEnv("HOME", "/gateway-home");
    try {
      const { resolveClaudeCredentialLaunch, options } = compose("/runtime/codex");
      expect(mocks.createClaude).toHaveBeenCalledWith({ homePath: "/runtime-home", resolveCredentialLaunch: resolveClaudeCredentialLaunch });
      await resolveClaudeCredentialLaunch();
      expect(mocks.credentials).toHaveBeenCalledWith("/runtime-home", process.env, undefined, undefined);
      expect(options).toMatchObject(dependencies);
      options.skillsSource?.();
      expect(mocks.skills).toHaveBeenCalledWith("/runtime-home");
      const codexOptions = mocks.createCodex.mock.calls[0]?.[0] as {
        executable?: string; cwd?: string; environment?: Record<string, string>;
      };
      expect(codexOptions.executable).toBe("/runtime/codex");
      expect(codexOptions.cwd).toBe("/runtime-home");
      expect(codexOptions.environment?.HOME).toBe("/runtime-home");
      expect(codexOptions.environment?.MATRIX_HOME).toBe("/runtime-home");
      expect(codexOptions.environment?.PATH).toBeDefined();
      expect(mocks.createNative).toHaveBeenCalledWith({ homePath: "/runtime-home" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds a Codex-first readiness view that falls back to the complete cached catalog", async () => {
    compose("/runtime/codex");
    expect(mocks.catalog).toHaveBeenCalledTimes(3);
    const [live, completeReadiness, codexReadiness] = mocks.catalog.mock.calls.map((call) => call[0] as CatalogOptions);
    expect(live.cacheTtlMs).toBeUndefined();
    expect(completeReadiness.cacheTtlMs).toBe(15_000);
    expect(codexReadiness.cacheTtlMs).toBe(15_000);
    expect(codexReadiness.preferredCodingProviderId).toBe("codex");
    // One Claude source instance, so a readiness read never re-resolves owner credentials on its own.
    expect(codexReadiness.codingModelCatalogSource).toBe(live.codingModelCatalogSource);
    expect(codexReadiness.invalidateCodingModelCatalog).toBe(live.invalidateCodingModelCatalog);

    const unavailable = { instances: [] };
    const available = { instances: [{ driverKind: "codex", availability: "available", defaultSelection: { instanceId: "codex_default", model: "gpt-5" } }] };
    const codexService = { getCatalog: vi.fn().mockResolvedValue(available), refresh: vi.fn().mockResolvedValue(available) };
    const completeService = { getCatalog: vi.fn().mockResolvedValue(unavailable), refresh: vi.fn().mockResolvedValue(unavailable) };
    mocks.catalog.mockReset();
    mocks.catalog.mockReturnValueOnce({}).mockReturnValueOnce(completeService).mockReturnValueOnce(codexService);
    const { readinessCatalog } = compose("/runtime/codex");
    await expect(readinessCatalog.getCatalog(principal)).resolves.toBe(available);
    expect(completeService.getCatalog).not.toHaveBeenCalled();

    await expect(readinessCatalog.getCatalog(principal, "claude_code_default")).resolves.toBe(unavailable);
    expect(completeService.getCatalog).toHaveBeenCalledWith(principal);
    expect(codexService.getCatalog).toHaveBeenCalledTimes(1);

    codexService.getCatalog.mockResolvedValueOnce(unavailable);
    await expect(readinessCatalog.getCatalog(principal)).resolves.toBe(unavailable);
    expect(completeService.getCatalog).toHaveBeenCalledTimes(2);
  });

  it("returns owner-scoped Claude metadata without querying fallback sources", async () => {
    mocks.claude.mockResolvedValue(projection);
    const { source } = compose("/runtime/codex");
    await expect(source(provider, principal)).resolves.toBe(projection);
    expect(mocks.claude).toHaveBeenCalledWith(provider, principal);
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  });

  it("retains Codex priority over native metadata", async () => {
    mocks.codex.mockResolvedValue(projection);
    const { source } = compose("/runtime/codex");
    await expect(source(provider, principal)).resolves.toBe(projection);
    expect(mocks.codex).toHaveBeenCalledWith(provider);
    expect(mocks.native).not.toHaveBeenCalled();
  });

  it.each([undefined, "/runtime/codex"])("uses the native fallback with executable %s", async (executable) => {
    mocks.native.mockResolvedValue(projection);
    const { source } = compose(executable);
    await expect(source(provider, principal)).resolves.toBe(projection);
    expect(mocks.native).toHaveBeenCalledWith(provider);
    expect(mocks.createCodex).toHaveBeenCalledTimes(executable ? 1 : 0);
  });

  it("forwards owner-scoped refresh invalidation", () => {
    const { options } = compose();
    options.invalidateCodingModelCatalog?.(principal);
    expect(mocks.claude.invalidate).toHaveBeenCalledWith(principal);
  });
});
