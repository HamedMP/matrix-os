import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import { EventEmitter } from "node:events";
import { managedChatInstances } from "../../packages/gateway/src/chat/managed-chat-catalog.js";
import { createGatewayChatProviderCatalog } from "../../packages/gateway/src/chat/runtime-provider-catalog.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKernelChatProviderAdapter } from "../../packages/gateway/src/chat/kernel-provider-adapter.js";
import { createChatProviderCatalogService, validateChatProviderSelection } from "../../packages/gateway/src/chat/provider-catalog.js";
import { buildKernelCredentialLaunch, resolveKernelCredentialMode, resolveKernelCredentialSources } from "../../packages/gateway/src/kernel-credentials.js";
import { makeAiProviderSnapshot } from "../fixtures/ai-provider-snapshot.js";
import type { CodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { MatrixFundedCredentialProvider } from "../../packages/gateway/src/funded-ai-credential-manager.js";

const selection = { instanceId: "kernel_matrix_included", model: "claude-sonnet-5" };
const recovery = { code: "model_unavailable", retryable: false, recoveryActions: ["start_new_chat"] };
const input = () => ({
  owner: { type: "personal" as const, ownerId: "owner_1" }, chatId: "chat_1", turnId: "turn_1", runId: "run_1",
  prompt: "Hello", parts: [{ type: "text" as const, text: "Hello" }], selection,
  interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal,
});

describe("Matrix AI SDK retirement", () => {
  let homePath: string;
  beforeEach(() => { homePath = mkdtempSync(join(tmpdir(), "matrix-sdk-retirement-")); mkdirSync(join(homePath, "system")); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(homePath, { recursive: true, force: true }); });

  it("publishes only the policy-backed owned Pi Matrix harness", async () => {
    const catalog = await createChatProviderCatalogService({
      codingProviders: { listProviders: async () => [], invalidate: () => {} } as unknown as CodingAgentProviderRegistry,
      agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null }, providers: [], messaging: { runtime: "hermes", provider: null, model: null, configured: false } }),
      aiProviderSource: { getSnapshot: async () => makeAiProviderSnapshot() }, executableDriverKinds: ["kernel", "matrix_pi"],
    }).getCatalog({ userId: "owner_1", source: "jwt" });
    expect(catalog.instances.some((instance) => instance.id === "kernel_matrix_included")).toBe(false);
    expect(catalog.instances.find((instance) => instance.id === "matrix_pi_default")).toMatchObject({ availability: "available" });
    expect(validateChatProviderSelection({ catalog, selection })).toMatchObject({ ok: false, error: recovery });
    // A stale or forged catalog must not re-enable the historical executable route.
    const staleCatalog = { ...catalog, instances: [...catalog.instances, ...managedChatInstances(makeAiProviderSnapshot(), [])] };
    expect(validateChatProviderSelection({ catalog: staleCatalog, selection, boundInstanceId: selection.instanceId })).toMatchObject({ ok: false, error: recovery });
  });

  it.each(["start", "resume"] as const)("blocks legacy %s before dispatcher and preserves opaque state parsing", async (method) => {
    const dispatch = vi.fn(async () => {});
    const adapter = createKernelChatProviderAdapter({ dispatcher: { dispatch } });
    expect(adapter.parseState({ sessionId: "old_sdk_session" })).toEqual({ sessionId: "old_sdk_session" });
    const events = [];
    for await (const event of adapter[method]!({ ...input(), resumeState: { sessionId: "old_sdk_session" } })) events.push(event);
    expect(events).toEqual([{ type: "run.completed", outcome: "failed", error: expect.objectContaining(recovery) }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["matrix_included", "kernel_matrix_included_alias"])("rejects forged kernel alias %s before dispatch", async (instanceId) => {
    const dispatch = vi.fn(async () => {});
    const adapter = createKernelChatProviderAdapter({ dispatcher: { dispatch } });
    await expect((async () => {
      for await (const event of adapter.start({ ...input(), selection: { ...selection, instanceId } })) { void event; }
    })()).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["interactive", "background"] as const)("denies explicit and implicit %s SDK funding before lease, even with owner fallback available", async (requestClass) => {
    const getCredential = vi.fn();
    const provider = { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider;
    const env = { ANTHROPIC_API_KEY: "untrusted-platform-key", ANTHROPIC_BASE_URL: "https://relay.example" };
    await expect(buildKernelCredentialLaunch(homePath, env, undefined, provider, { requestClass })).rejects.toThrow();
    writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    await expect(buildKernelCredentialLaunch(homePath, env, "matrix_included", provider, { requestClass })).rejects.toThrow();
    expect(getCredential).not.toHaveBeenCalled();
    await expect(buildKernelCredentialLaunch(homePath, env, "owner_anthropic_key", provider, { requestClass })).resolves.toMatchObject({ env: { ANTHROPIC_API_KEY: "owner-key" } });
  });

  it("fails closed without owner credentials while retaining readonly Matrix source observations", async () => {
    const getCredential = vi.fn();
    const provider = { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider;
    await expect(buildKernelCredentialLaunch(homePath, { ANTHROPIC_API_KEY: "ambient-key" }, undefined, undefined, { requestClass: "interactive" })).rejects.toThrow();
    await expect(resolveKernelCredentialMode(homePath)).resolves.toBe("platform");
    await expect(resolveKernelCredentialSources(homePath, {}, provider)).resolves.toMatchObject({ matrixIncluded: { state: "ready" } });
    expect(getCredential).not.toHaveBeenCalled();
  });
  it("blocks the production native Claude resolver before process spawn without owner credentials", async () => {
    const getCredential = vi.fn();
    const provider = { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider;
    const { resolveClaudeCredentialLaunch } = createGatewayChatProviderCatalog({
      homePath, fundedCredentialProvider: provider,
      codingProviders: { listProviders: async () => [], invalidate: () => {} } as unknown as CodingAgentProviderRegistry,
      agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null }, providers: [], messaging: { runtime: "hermes", provider: null, model: null, configured: false } }),
    });
    const spawnFn = vi.fn();
    const adapter = createClaudeChatProviderAdapter({ homePath, spawnFn, resolveCredentialLaunch: resolveClaudeCredentialLaunch });
    const run = adapter.start({ ...input(), selection: { instanceId: "claude_code_default", model: "claude-sonnet-5" } });
    await expect(run[Symbol.asyncIterator]().next()).rejects.toThrow();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "connected-owner-key" } }));
    await expect(resolveClaudeCredentialLaunch()).resolves.toMatchObject({ env: { ANTHROPIC_API_KEY: "connected-owner-key" } });
    expect(getCredential).not.toHaveBeenCalled();
  });

  it.each(["key", "profile"] as const)("keeps production native Claude %s execution owner-scoped with ambient auth present", async (kind) => {
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth-token");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-matrix-funded-claim-key: old-run");
    if (kind === "key") writeFileSync(join(homePath, "system/config.json"), JSON.stringify({ kernel: { anthropicApiKey: "owner-key" } }));
    else writeFileSync(join(homePath, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "owner-account" } }));
    const getCredential = vi.fn();
    const { resolveClaudeCredentialLaunch } = createGatewayChatProviderCatalog({
      homePath, fundedCredentialProvider: { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider,
      codingProviders: { listProviders: async () => [], invalidate: () => {} } as unknown as CodingAgentProviderRegistry,
      agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null }, providers: [], messaging: { runtime: "hermes", provider: null, model: null, configured: false } }),
    });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } },
      kill: vi.fn(),
    });
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Owner reply", session_id: "owner_session" })}\n`));
        child.emit("exit", 0, null);
      });
      return child;
    });
    const adapter = createClaudeChatProviderAdapter({ homePath, spawnFn, resolveCredentialLaunch: resolveClaudeCredentialLaunch });
    const events = [];
    for await (const event of adapter.start({ ...input(), selection: { instanceId: "claude_code_default", model: "claude-sonnet-5" } })) events.push(event);
    const env = spawnFn.mock.calls[0]?.[2]?.env;
    expect(env?.HOME).toBe(homePath);
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
    if (kind === "key") expect(env?.ANTHROPIC_API_KEY).toBe("owner-key");
    else expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    expect(getCredential).not.toHaveBeenCalled();
  });

});
