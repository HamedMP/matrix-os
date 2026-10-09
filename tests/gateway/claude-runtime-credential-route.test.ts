import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createGatewayChatProviderCatalog } from "../../packages/gateway/src/chat/runtime-provider-catalog.js";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import type { CodingAgentProviderRegistry } from "../../packages/gateway/src/coding-agents/provider-registry.js";
import type { MatrixFundedCredentialProvider } from "../../packages/gateway/src/funded-ai-credential-manager.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(close => close())); });

async function fixture(source = "owner_claude_profile") {
  const root = await mkdtemp(join(tmpdir(), "claude-runtime-route-"));
  const homePath = join(root, "home");
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(join(homePath, "system/ai-providers/anthropic-key.json"), JSON.stringify({ version: 1, apiKey: "synthetic-owner-key" }), { mode: 0o600 });
  // A profile marker routes credentials, but is not proof of successful OAuth.
  await writeFile(join(homePath, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "synthetic-profile" } }));
  const service = new AiProviderService({ homePath, env: {}, exposeClaudeProfileAccount: true, driverInventory: async () => [{
    id: "claude_code", displayName: "Claude Code", installState: "installed", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"],
  }] });
  const store = new ProviderSettingsStore({ homePath, privateRootPath: join(root, "private"), providerSnapshotReader: service,
    runtimeCoordinator: { supportedActions: ["select_access_source", "set_harness_enabled"], isRecoveryReady: () => true,
      reconcilePending: async () => {}, applyConfiguration: async () => {}, rollbackConfiguration: async () => {} },
  });
  cleanup.push(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  const initial = await store.getSnapshot();
  const harness = initial.harnesses.find(row => row.harness === "claude")!;
  await store.mutate({ type: "select_access_source", harnessInstanceId: harness.id, accessSourceId: source,
    enableHarness: true, expectedRevision: initial.revision, idempotencyKey: "explicit-route" });
  const getCredential = vi.fn();
  const fundedCredentialProvider = { enabled: true, getCredential } as unknown as MatrixFundedCredentialProvider;
  const getSnapshot = vi.fn((...args: Parameters<typeof store.getSnapshot>) => store.getSnapshot(...args));
  const compose = (reader = getSnapshot) => createGatewayChatProviderCatalog({
    homePath, fundedCredentialProvider, harnessSettingsSource: { getSnapshot: reader },
    codingProviders: { listProviders: async () => [], invalidate: () => {} } as unknown as CodingAgentProviderRegistry,
    agentRuntimeSource: async () => ({ runtime: { selected: "hermes", options: [], transition: null }, providers: [], messaging: { runtime: "hermes", provider: null, model: null, configured: false } }),
  });
  return { homePath, harness, store, compose, getSnapshot, getCredential };
}

function input(instanceId: string) {
  return { owner: { type: "personal" as const, ownerId: "owner_1" }, chatId: "chat_1", turnId: "turn_1", runId: "run_1",
    prompt: "Hello", parts: [{ type: "text" as const, text: "Hello" }], selection: { instanceId, model: "claude-sonnet-5" },
    interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal };
}

function successfulSpawn() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } }, kill: vi.fn() });
  return vi.fn<CanonicalCliSpawn>(() => {
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Synthetic reply", session_id: "synthetic_session" })}\n`));
      child.emit("exit", 0, null);
    });
    return child;
  });
}

describe("production native Claude credential resolver", () => {
  it("uses the explicitly connected native profile rather than a prior saved or ambient API key", async () => {
    const f = await fixture();
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key"); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token"); vi.stubEnv("ANTHROPIC_BASE_URL", "https://other.invalid");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/other/profile");
    const before = await f.store.getSnapshot();
    const launch = await f.compose().resolveClaudeCredentialLaunch({ runId: "run_1" });
    expect(launch.env?.HOME).toBe(f.homePath);
    for (const variable of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"]) expect(launch.env).not.toHaveProperty(variable);
    expect(f.getSnapshot).toHaveBeenCalledWith({ suppressFundedProbes: true });
    const after = await f.store.getSnapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.harnesses).toEqual(before.harnesses);
    expect(f.getCredential).not.toHaveBeenCalled();
  });

  it("passes the same native resolver into the actual adapter before spawning", async () => {
    const f = await fixture();
    const spawnFn = successfulSpawn();
    const adapter = createClaudeChatProviderAdapter({ homePath: f.homePath, spawnFn, resolveCredentialLaunch: f.compose().resolveClaudeCredentialLaunch });
    const events = [];
    for await (const event of adapter.start(input(f.harness.id))) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    expect(spawnFn.mock.calls[0]?.[2]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(spawnFn.mock.calls[0]?.[2]?.env?.HOME).toBe(f.homePath);
    expect(f.getCredential).not.toHaveBeenCalled();
  });

  it("preserves the historical owner key route when no native source was selected", async () => {
    const f = await fixture("owner_anthropic_key");
    await expect(f.compose().resolveClaudeCredentialLaunch()).resolves.toMatchObject({ env: { ANTHROPIC_API_KEY: "synthetic-owner-key" } });
    expect(f.getCredential).not.toHaveBeenCalled();
  });

  it("rejects a missing selected native profile before adapter spawn or any funding request", async () => {
    const f = await fixture();
    await unlink(join(f.homePath, ".claude.json"));
    const spawnFn = vi.fn();
    const adapter = createClaudeChatProviderAdapter({ homePath: f.homePath, spawnFn, resolveCredentialLaunch: f.compose().resolveClaudeCredentialLaunch });
    await expect(adapter.start(input(f.harness.id))[Symbol.asyncIterator]().next()).rejects.toThrow("Selected AI access is unavailable");
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.getCredential).not.toHaveBeenCalled();
  });

  it.each(["disabled", "missing-account", "wrong-account", "missing-source", "wrong-route", "ineligible-model", "multiple-enabled", "conflicting-saved-source", "conflicting-projected-source"])("fails closed for %s native configuration instead of charging the old key", async scenario => {
    const f = await fixture();
    const snapshot = structuredClone(await f.store.getSnapshot());
    const row = snapshot.harnesses.find(row => row.id === f.harness.id)!;
    if (scenario === "disabled") { row.configuredEnabled = false; row.enabled = false; }
    if (scenario === "missing-account") snapshot.accounts = snapshot.accounts.filter(account => account.id !== "owner_claude_profile");
    if (scenario === "wrong-account") row.selectedAccountId = "owner_anthropic";
    if (scenario === "missing-source") snapshot.accessSources = snapshot.accessSources.filter(source => source.id !== "owner_claude_profile");
    if (scenario === "wrong-route") row.route.providerId = "openai";
    if (scenario === "ineligible-model") snapshot.accessSources.find(source => source.id === "owner_claude_profile")!.eligibleModelIds = [];
    if (scenario === "multiple-enabled") snapshot.harnesses.push({ ...row, id: "second-claude" });
    if (scenario === "conflicting-saved-source") row.configuredAccessSourceId = "owner_anthropic_key";
    if (scenario === "conflicting-projected-source") row.accessSourceId = "owner_anthropic_key";
    const reader = vi.fn(async (): Promise<ProviderSettingsSnapshot> => snapshot);
    const spawnFn = vi.fn();
    const adapter = createClaudeChatProviderAdapter({ homePath: f.homePath, spawnFn, resolveCredentialLaunch: f.compose(reader).resolveClaudeCredentialLaunch });
    await expect(adapter.start(input(f.harness.id))[Symbol.asyncIterator]().next()).rejects.toThrow("Selected AI access is unavailable");
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.getCredential).not.toHaveBeenCalled();
  });

  it("uses saved enabled intent even when the operational projection is temporarily disabled", async () => {
    const f = await fixture();
    const snapshot = structuredClone(await f.store.getSnapshot());
    snapshot.harnesses.find(row => row.id === f.harness.id)!.enabled = false;
    const reader = vi.fn(async (): Promise<ProviderSettingsSnapshot> => snapshot);
    const launch = await f.compose(reader).resolveClaudeCredentialLaunch();
    expect(launch.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(f.getCredential).not.toHaveBeenCalled();
  });
});
