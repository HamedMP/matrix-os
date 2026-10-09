import { Hono } from "hono";
import { ProviderWorkflowSchema } from "@matrix-os/contracts";
import { registerProviderWorkflowRuntime } from "../../packages/gateway/src/server/provider-workflow-runtime.js";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createProviderTerminalLoginHandoff } from "../../packages/gateway/src/ai-providers/provider-terminal-login-handoff.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { createOwnerAnthropicKeyPreflight } from "../../packages/gateway/src/ai-providers/owner-key-preflight.js";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createClaudeSettingsLogin } from "../../packages/gateway/src/ai-providers/provider-workflow-browser.js";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import { createClaudeNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { createProviderWorkflowService } from "../../packages/gateway/src/ai-providers/provider-workflows.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

// A native subprocess models the documented readline code#state boundary and
// persisted non-secret account metadata. It is not a real OAuth or quota test.
it.each(["empty-production", "empty", "api-key", "saved-profile"])("reconciles fresh-home Claude CLI login via authoritative native status with %s initial auth", async initialAuth => {
  const root = await mkdtemp(join(tmpdir(), "claude-settings-reconcile-")); homes.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  const script = `#!${process.execPath}

const fs=require('node:fs'), readline=require('node:readline');
// Official CLI global account metadata moves when CLAUDE_CONFIG_DIR is set,
// although the displayed configDirectory can still be HOME/.claude.
const globalAccount=process.env.CLAUDE_CONFIG_DIR?process.env.CLAUDE_CONFIG_DIR+'/.claude.json':process.env.HOME+'/.claude.json';
if(process.argv[2]==='auth' && process.argv[3]==='status') {
 const authenticated=fs.existsSync(globalAccount)&&fs.existsSync(process.env.HOME+'/.synthetic-cli-authenticated');
 console.log(JSON.stringify({loggedIn:authenticated,authMethod:authenticated?'claude.ai':'none',apiProvider:'firstParty',email:'fixture@example.invalid',configDirectory:process.env.CLAUDE_CONFIG_DIR||process.env.HOME+'/.claude',subscriptionType:'max'}));
 process.exit(authenticated?0:1);
}
console.log('https://claude.com/cai/oauth/authorize?state=fixture');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const [code,state]=line.trim().split('#');
 if(!code||!state) {console.error('Invalid code. Please make sure the full code was copied.');return;}
 fs.writeFileSync(globalAccount,JSON.stringify({oauthAccount:{accountUuid:'synthetic-account'}}));
 fs.writeFileSync(process.env.HOME+'/.synthetic-cli-authenticated','synthetic-local-receipt');
 console.log('Login successful.'); process.exit(0);
});`;
  const cliPath = join(root, "cli.cjs"); await writeFile(cliPath, script, { mode: 0o700 });
  const guard = createNativeProviderProfileGuard({ homePath: home, registry: { listProfileSessions: async () => [], get: vi.fn(), observeAgentLiveness: async () => "stopped" } });
  if (initialAuth === "saved-profile") await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "previous-unverified-account" } }));
  if (initialAuth === "api-key") {
    await mkdir(join(home, "system/ai-providers"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, "system/ai-providers/anthropic-key.json"), JSON.stringify({ version: 1, apiKey: "synthetic-owner-key" }), { mode: 0o600 });
  }
  const healthFetch = vi.fn<typeof fetch>(async () => { throw new Error("fixture must not call a remote provider"); });
  const service = new AiProviderService({ homePath: home, env: initialAuth === "api-key" ? { ANTHROPIC_API_KEY: "synthetic-api-key" } : {}, exposeClaudeProfileAccount: true, healthProbe: createOwnerAnthropicKeyPreflight({ homePath: home, fetchFn: healthFetch }), driverInventory: async () => [{
    id: "claude_code", displayName: "Claude Code", installState: "installed", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"],
  }, { id: "hermes", displayName: "Hermes", installState: "installed", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"] }] });
  const usageReader = vi.fn(async () => null);
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, "private"), providerSnapshotReader: service,
    claudeNativeAccountMetadataReader: createClaudeNativeAccountMetadataReader({ executable: cliPath, cwd: home, environment: { HOME: home }, usageReader }),
    runtimeCoordinator: initialAuth === "empty-production" ? createProviderGenericHarnessCoordinator({ homePath: home, enabledCodingHarnesses: [], runtimeController: { update: vi.fn(async () => { throw new Error("native completion must preserve the system runtime"); }) }, runtimeSource: async () => { throw new Error("native completion must not read a system route"); } }) : { supportedActions: ["set_harness_enabled", "select_access_source", "add_harness"], isRecoveryReady: () => true,
      reconcilePending: async () => {}, applyConfiguration: async () => {}, rollbackConfiguration: async () => {} },
    loginCoordinator: { supportedMethods: () => ["terminal"], startLogin: async () => { throw new Error("must stay in Settings"); } },
  });
  const initial = await store.getSnapshot();
  const harness = initial.harnesses.find(row => row.harness === "claude")!;
  await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false,
    expectedRevision: initial.revision, idempotencyKey: "initial-off" });
  if (["api-key", "saved-profile"].includes(initialAuth)) {
    const before = await store.getSnapshot();
    await store.mutate({ type: "select_access_source", harnessInstanceId: harness.id,
      accessSourceId: initialAuth === "api-key" ? "owner_anthropic_key" : "owner_anthropic_profile",
      expectedRevision: before.revision, idempotencyKey: "select-existing-legacy" });
  }
  if (initialAuth === "saved-profile") {
    const before = await store.getSnapshot();
    const source = before.accessSources.find(source => source.id === "owner_anthropic_profile")!;
    await store.mutate({ type: "add_harness", harness: "hermes", displayName: "Existing Hermes", route: { ...harness.route, kind: "configurable" }, accessSourceId: source.id, accountId: source.accountId,
      expectedRevision: before.revision, idempotencyKey: "add-existing-hermes" });
    const added = await store.getSnapshot();
    const hermes = added.harnesses.find(row => row.displayName === "Existing Hermes")!;
    await store.mutate({ type: "set_harness_enabled", harnessInstanceId: hermes.id, enabled: true,
      expectedRevision: added.revision, idempotencyKey: "enable-existing-hermes" });
  }
  const beforeConnect = await store.getSnapshot();
  const previousClaude = beforeConnect.harnesses.find(row => row.id === harness.id)!;
  const previousHermes = beforeConnect.harnesses.find(row => row.displayName === "Existing Hermes");
  const release = vi.fn();
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn() };
  // Match server.ts: native workflows receive the Terminal handoff facade,
  // not the underlying store. A browser completion never resolves a Terminal ref.
  const terminalRefResolver = vi.fn(async () => { throw new Error("browser completion must not resolve Terminal"); });
  const workflowStore = initialAuth === "empty-production"
    ? createProviderTerminalLoginHandoff(store, terminalRefResolver) : store;
  const adapters = await createNativeProviderWorkflowAdapters({ store: workflowStore, terminal, hostControl: { available: false, run: vi.fn() },
    claudeBrowserLogin: createClaudeSettingsLogin({ command: cliPath, args: ["auth", "login", "--claudeai"], cwd: home, env: { HOME: home }, acquire: async () => { const drain = await guard.acquire("claude", { kind: "write", durable: true }); return async () => { await drain(); release(); }; } }) });
  const workflows = createProviderWorkflowService({ ownerId: "fixture-owner", adapters });
  const app = new Hono();
  let principal = "fixture-owner";
  const lifecycle = initialAuth === "empty-production" ? await registerProviderWorkflowRuntime({
    app, ownerId: "fixture-owner", getPrincipal: () => ({ userId: principal }), createAdapters: async () => adapters,
  }) : undefined;
  const base = "/api/ai/provider-settings/workflows";
  const post = (path: string, body: object) => app.request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const status = async (id: string) => lifecycle ? ProviderWorkflowSchema.parse(await (await app.request(`${base}/${id}`)).json()) : workflows.status("fixture-owner", id);
  try {
    if (initialAuth !== "saved-profile") await expect(access(join(home, ".claude.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const request = { harnessInstanceId: harness.id, kind: "login" as const, method: "browser" as const, idempotencyKey: "native-manual-code" };
    if (lifecycle) {
      principal = "other-owner";
      expect((await post("", request)).status).toBe(403);
      principal = "fixture-owner";
    }
    const operation = lifecycle ? ProviderWorkflowSchema.parse(await (await post("", request)).json()) : await workflows.start("fixture-owner", request);
    await vi.waitFor(async () => expect((await status(operation.id)).authorizationUrl).not.toBeNull(), { timeout: 10000 });
    if (lifecycle) expect((await post(`/${operation.id}/code`, { code: "synthetic-code#fixture" })).status).toBe(200);
    else await workflows.submitCode("fixture-owner", operation.id, "synthetic-code#fixture");
    await vi.waitFor(async () => expect((await status(operation.id)).state).toBe("succeeded"), { timeout: 10000 });
    expect(usageReader).not.toHaveBeenCalled();
    const fresh = await store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true });
    expect(usageReader).toHaveBeenCalledOnce();
    expect(fresh.harnesses.find(row => row.id === harness.id)).toMatchObject({ enabled: true, configuredEnabled: true, authState: "authenticated", accessSourceId: "owner_claude_profile" });
    const connected = fresh.harnesses.find(row => row.id === harness.id)!;
    expect(connected.selectedAccountId).toBe("owner_claude_profile");
    if (["api-key", "saved-profile"].includes(initialAuth)) expect(connected.selectedAccountId).not.toBe(previousClaude.selectedAccountId);
    if (previousHermes) {
      expect(previousHermes.enabled).toBe(true);
      expect(fresh.harnesses.find(row => row.id === previousHermes.id)).toMatchObject({
        selectedAccountId: previousHermes.selectedAccountId, accessSourceId: previousHermes.accessSourceId,
        configuredEnabled: true, route: previousHermes.route,
      });
    }
    expect(fresh.accessSources.find(source => source.id === "owner_claude_profile")?.readiness.state).toBe("unknown");
    expect(terminal.createTab).not.toHaveBeenCalled();
    expect(terminalRefResolver).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(healthFetch).not.toHaveBeenCalled();
  } finally { await lifecycle?.close(); await workflows.close(); service.close(); }
});
