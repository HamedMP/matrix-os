import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { normalizeClaudeNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import { normalizeCodexNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";

import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import { createProviderWorkflowService } from '../../packages/gateway/src/ai-providers/provider-workflows.js';
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { createChatProviderCatalogService } from "../../packages/gateway/src/chat/provider-catalog.js";
import { createProviderSettingsRoutes } from "../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";

const roots: string[] = [], services: AiProviderService[] = [];
afterEach(async () => { services.splice(0).forEach(service => service.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(unboundProof = false, withClaude = false) {
  const root = await mkdtemp(join(tmpdir(), "codex-completion-admission-")); roots.push(root);
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  let loggedIn = true, principal = "fixture@example.invalid", installed = true, metadataMode = "native";
  const runCommand = vi.fn(async () => ({ principal, loggedIn }));
  const readMetadata = async (options?: { purpose: "native_completion" }) => {
    const observation = await runCommand();
    if (!observation.loggedIn) return null;
    const metadata = normalizeCodexNativeAccountMetadata({ account: metadataMode === "key" ? { type: "apiKey" } : { type: "chatgpt", email: observation.principal } }, options ? {} : { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }, new Date(metadataMode === "expired" ? 0 : Date.now()))!;
    return unboundProof ? metadata : bindNativeAccountMetadata(metadata, async () => loggedIn && principal === observation.principal, observation.principal);
  };
  const systemUpdate = vi.fn(async () => { throw new Error("fixed native completion cannot change system routing"); });
  const systemRead = vi.fn(async () => { throw new Error("fixed native completion cannot inspect system routing"); });
  const runtime = createProviderGenericHarnessCoordinator({ homePath: home, enabledCodingHarnesses: [], runtimeController: { update: systemUpdate }, runtimeSource: systemRead });
  const service = new AiProviderService({ homePath: home, env: { OPENAI_API_KEY: "synthetic-existing-key" }, exposeClaudeProfileAccount: withClaude,
    driverInventory: async () => [{ id: "codex", displayName: "Codex Code", installState: installed ? "installed" : "missing", kind: "cli", health: "ready", setupActions: [], capabilities: ["tools", "resume"] }, ...(withClaude ? [{ id: "claude_code" as const, displayName: "Claude", installState: "installed" as const, kind: "cli" as const, health: "ready" as const, setupActions: [], capabilities: ["tools", "resume"] }] : [])] }); services.push(service);
  const releaseRevocation = vi.fn(async () => {});
  const prepareRevocation = vi.fn(async () => releaseRevocation);
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, "private"), providerSnapshotReader: service,
    loginCoordinator: { supportedMethods: () => ["terminal"], startLogin: async ({ mutation }) => ({ id: "attempt_fixture", harnessInstanceId: mutation.harnessInstanceId, accountId: mutation.accountId, method: "terminal", state: "pending", action: { kind: "open_terminal", terminalSessionId: "workspace:login" }, expiresAt: new Date(Date.now() + 60000).toISOString(), safeFailure: null }) },
    runtimeCoordinator: runtime, codexNativeAccountMetadataReader: readMetadata, prepareNativeCodexRevocation: prepareRevocation,
    ...(withClaude ? { claudeNativeAccountMetadataReader: async () => bindNativeAccountMetadata(normalizeClaudeNativeAccountMetadata({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'claude@example.invalid', subscriptionType: 'max', configDirectory: join(home, '.claude') }, home, new Date())!, async () => true, 'claude-fixture-principal') } : {}) });
  const initial = await store.getSnapshot(), harness = initial.harnesses.find(row => row.harness === "codex")!;
  await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: "fixture-off" });
  // Represent an existing owner API-key selection without enabling public route writes.
  const config = JSON.parse(await readFile(store.configurationPath, "utf8"));
  const saved = config.harnesses.find((row: { id: string }) => row.id === harness.id);
  saved.accessSourceId = "owner_openai_key"; saved.selectedAccountId = "owner_openai";
  await writeFile(store.configurationPath, JSON.stringify(config));
  const before = await store.getSnapshot();
  const input = { harnessInstanceId: harness.id, expectedRevision: before.revision, idempotencyKey: "fixture-complete" };
  return { home, store, before, input, runtime, prepareRevocation, releaseRevocation, systemRead, systemUpdate, readMetadata, runCommand,
    setLoggedIn: (value: boolean) => { loggedIn = value; }, setPrincipal: (value: string) => { principal = value; },
    removeDriver: () => { installed = false;  }, setMetadataMode: (mode: string) => { metadataMode = mode; } };
}

it("completes the production fixed Codex client, selects the verified subscription rather than its saved key, and replays without reenabling", async () => {
  const f = await fixture();
  const complete = await f.store.completeCodexNativeLogin(f.input);
  const savedConfiguration = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(savedConfiguration.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId).nativeAccountGeneration).toMatch(/^[a-f0-9]{64}$/);
  const connected = complete.snapshot.harnesses.find(row => row.id === f.input.harnessInstanceId)!;
  expect(connected).toMatchObject({ accessSourceId: "owner_openai_profile", selectedAccountId: "owner_codex", enabled: true, configuredEnabled: true });
  expect(connected.route).toEqual(f.before.harnesses.find(row => row.id === connected.id)!.route);
  expect(f.runtime.supportedActions).not.toContain("select_access_source");
  await expect(f.store.mutate({ ...f.input, expectedRevision: complete.snapshot.revision, type: "select_access_source", accessSourceId: "owner_openai_key", enableHarness: true, idempotencyKey: "public-selection" })).rejects.toMatchObject({ code: "runtime_unavailable" });
  const off = await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: connected.id, expectedRevision: complete.snapshot.revision, enabled: false, idempotencyKey: "owner-disconnect" });
  const afterOff = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(afterOff.harnesses.find((row: {id: string}) => row.id === connected.id).nativeAccountGeneration).toBeUndefined();
  const replay = await f.store.completeCodexNativeLogin(f.input);
  expect(replay.snapshot.revision).toBe(off.snapshot.revision);
  expect(replay.snapshot.harnesses.find(row => row.id === connected.id)?.configuredEnabled).toBe(false);
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
});

it.each(["signed-out", "changed-principal", "missing-driver", "stale-revision", "wrong-harness"] as const)("preserves the previous key and Off when completion admission rejects %s", async mode => {
  const f = await fixture();
  // A successful outer workflow/UI read cannot authorize the later commit.
  expect(await f.readMetadata()).not.toBeNull();
  if (mode === "signed-out") f.setLoggedIn(false);
  if (mode === "changed-principal") {
    f.runCommand.mockImplementationOnce(async () => ({ principal: "old@example.invalid", loggedIn: true }));
    f.setPrincipal("new@example.invalid");
  }
  if (mode === "missing-driver") f.removeDriver();
  const input = { ...f.input, ...(mode === "stale-revision" ? { expectedRevision: f.input.expectedRevision - 1 } : {}), ...(mode === "wrong-harness" ? { harnessInstanceId: "harness_claude_code" } : {}) };
  await expect(f.store.completeCodexNativeLogin(input)).rejects.toBeDefined();
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_openai_key", configuredEnabled: false });
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
});

it.each(["principal", "driver"] as const)("compensates the real coordinator receipt if the native %s changes before owner settings commit", async mode => {
  const f = await fixture();
  const apply = f.runtime.applyConfiguration.bind(f.runtime);
  f.runtime.applyConfiguration = async input => { await apply(input); if (mode === "principal") f.setPrincipal("replacement@example.invalid"); else f.removeDriver(); };
  await expect(f.store.completeCodexNativeLogin(f.input)).rejects.toMatchObject({ code: "invalid_route" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_openai_key", configuredEnabled: false });
  const config = JSON.parse(await readFile(f.store.configurationPath, "utf8"));
  expect(config.receipts.some((receipt: { key: string }) => receipt.key === f.input.idempotencyKey)).toBe(false);
  const runtimeReceipts = JSON.parse(await readFile(join(roots.at(-1)!, "home/system/ai-providers/runtime-receipts.json"), "utf8"));
  expect(runtimeReceipts.receipts.some((receipt: { key: string }) => receipt.key === f.input.idempotencyKey)).toBe(false);
});


it("rejects an authenticated-looking metadata object without the private current-principal binding", async () => {
  const f = await fixture(true);
  await expect(f.store.completeCodexNativeLogin(f.input)).rejects.toMatchObject({ code: "invalid_route" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)).toMatchObject({ configuredAccessSourceId: "owner_openai_key", configuredEnabled: false });
  expect(f.systemRead).not.toHaveBeenCalled();
  expect(f.systemUpdate).not.toHaveBeenCalled();
});

it("does not accept a trusted-completion flag from a public settings mutation", async () => {
  const f = await fixture();
  const forged = { ...f.input, type: "select_access_source" as const, accessSourceId: "owner_openai_profile", enableHarness: true, codexNativeCompletion: true };
  await expect(f.store.mutate(forged)).rejects.toMatchObject({ code: "invalid_request" });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
  expect(f.runCommand).not.toHaveBeenCalled();
});


it.each(['key', 'expired'] as const)('rejects %s metadata rather than enabling a fallback source', async mode => {
  const f = await fixture(); f.setMetadataMode(mode);
  await expect(f.store.completeCodexNativeLogin(f.input)).rejects.toMatchObject({ code: 'invalid_route' });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(f.before.revision);
  expect(after.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
});


it('drains native sessions before Off and does not commit Off after ambiguous cleanup', async () => {
  const f = await fixture();
  f.prepareRevocation.mockRejectedValueOnce(new Error('synthetic-unknown-cleanup'));
  await expect(f.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: f.input.harnessInstanceId, enabled: false, expectedRevision: f.before.revision, idempotencyKey: 'failed-drain' })).rejects.toBeDefined();
  expect((await f.store.getSnapshot()).revision).toBe(f.before.revision);
});


it('automatically completes a saved native Codex connection during an owner read', async () => {
  const f = await fixture();
  const config = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  const native = config.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId);
  native.enabled = true; native.accessSourceId = 'owner_openai_profile'; native.selectedAccountId = 'owner_codex';
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  const legacy = await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  expect(legacy.accounts.find(row => row.id === 'owner_codex')?.authState).toBe('authenticated');
  expect(legacy.accessSources.find(row => row.id === 'owner_openai_profile')?.readiness.state).toBe('ready');
  expect(legacy.harnesses.find(row => row.id === native.id)).toMatchObject({ enabled: true, configuredEnabled: true });
  const saved = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(saved.revision).toBe(config.revision + 1);
  expect(saved.harnesses.find((row: {id: string}) => row.id === native.id)).toMatchObject({ nativeAccountGeneration: expect.stringMatching(/^[a-f0-9]{64}$/), nativeAccountConsentRevision: saved.revision });
  expect((await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true })).revision).toBe(saved.revision);
  expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
});
it('updates the exact native account method after a previously signed-out key is explicitly replaced by subscription consent', async () => {
  const f = await fixture();
  const config = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  config.accountProfiles.find((row: {id: string}) => row.id === 'owner_codex').authMethod = 'api_key';
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  await f.store.completeCodexNativeLogin(f.input);
  const saved = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(saved.accountProfiles.find((row: {id: string}) => row.id === 'owner_codex').authMethod).toBe('terminal');
});

it.each([false, true])("binds foreground completion to the real store login revision (intervening Off: %s)", async off => {
  const f = await fixture();
  let observer: { onFrame(frame: unknown): void } | undefined;
  let commandExited = false;
  const terminal = { listWorkspaces: async () => [{ tabs: [{ workspaceId: 'workspace', id: 'login', incarnation: 'ti_11111111111111111111111111111111' }] }], getCommandResult: async () => commandExited ? { state: 'exited', exitCode: 0 } : { state: 'running' }, attach: (value: typeof observer) => { observer = value; return { close() {}, send() {} }; }, terminateTab: async () => {} };
  const [adapter] = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: terminal as never });
  const publish = vi.fn();
  await adapter!.start({ registerCleanup: vi.fn(), request: { harnessInstanceId: f.input.harnessInstanceId, kind: 'login', method: 'terminal', idempotencyKey: 'real-foreground' }, publish });
  const started = await f.store.getSnapshot();
  expect(started.revision).toBe(f.before.revision + 1);
  if (off) await f.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: f.input.harnessInstanceId, enabled: false, expectedRevision: started.revision, idempotencyKey: 'off-during-login' });
  commandExited = true;
  observer!.onFrame({ type: 'exit', revision: 1, exitCode: 0, terminalRef: { workspaceId: 'workspace', tabId: 'login' } });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: off ? 'failed' : 'succeeded', safeFailure: off ? 'unavailable' : null }));
  expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(!off);
});

it('preserves an already committing real native selection when cancel waits for completion', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const committing = new Promise<void>(resolve => { entered = resolve; });
  const apply = f.runtime.applyConfiguration.bind(f.runtime);
  f.runtime.applyConfiguration = async input => { await apply(input); entered(); await gate; };
  let commandExited = false;
  const terminal = {
    listWorkspaces: async () => [{ tabs: [{ workspaceId: 'workspace', id: 'login', incarnation: 'ti_11111111111111111111111111111111' }] }],
    getCommandResult: async () => commandExited ? { state: 'exited', exitCode: 0 } : { state: 'running' },
    attach: () => ({ close() {}, send() {} }), terminateTab: vi.fn(async () => {}),
  };
  const adapters = await createNativeProviderWorkflowAdapters({ store: f.store, terminal: terminal as never });
  const service = createProviderWorkflowService({ ownerId: 'owner', adapters });
  const operation = await service.start('owner', { harnessInstanceId: f.input.harnessInstanceId, kind: 'login', method: 'terminal', idempotencyKey: 'committing-before-cancel' });
  commandExited = true;
  try {
    await committing;
    const cancelled = service.cancel('owner', operation.id);
    release();
    await expect(cancelled).resolves.toMatchObject({ state: 'succeeded', safeFailure: null });
    const selected = (await f.store.getSnapshot()).harnesses.find(row => row.id === f.input.harnessInstanceId)!;
    expect(selected).toMatchObject({ configuredEnabled: true, configuredAccessSourceId: 'owner_openai_profile' });
    expect(f.systemRead).not.toHaveBeenCalled(); expect(f.systemUpdate).not.toHaveBeenCalled();
    expect(terminal.terminateTab).not.toHaveBeenCalled();
  } finally { release(); await service.close(); }
});

async function saveLegacyNativeConnection(f: Awaited<ReturnType<typeof fixture>>) {
  const config = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  const native = config.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId);
  Object.assign(native, { enabled: true, accessSourceId: 'owner_openai_profile', selectedAccountId: 'owner_codex' });
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  return config;
}

it('coalesces concurrent owner reads into one automatic completion', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true })));
  expect(results.every(result => result.harnesses.find(row => row.id === f.input.harnessInstanceId)?.enabled)).toBe(true);
  const after = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(after.revision).toBe(before.revision + 1);
});

it.each(['ordinary-read', 'non-owner-read', 'key-route', 'signed-out', 'unbound-proof', 'expired-proof', 'different-account'] as const)('does not repair using %s', async mode => {
  const f = await fixture(mode === 'unbound-proof'); const before = await saveLegacyNativeConnection(f);
  if (mode === 'key-route') {
    const native = before.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId);
    native.accessSourceId = 'owner_openai_key'; native.selectedAccountId = 'owner_openai';
    await writeFile(f.store.configurationPath, JSON.stringify(before));
  }
  if (mode === 'signed-out') f.setLoggedIn(false);
  if (mode === 'expired-proof') f.setMetadataMode('expired');
  if (mode === 'different-account') {
    await f.store.completeCodexNativeLogin(f.input);
    f.setPrincipal('replacement@example.invalid');
  }
  const revision = (await f.store.getSnapshot()).revision;
  await f.store.getSnapshot({ includeNativeAccountMetadata: mode !== 'ordinary-read', recoverNativeConnection: mode !== 'non-owner-read' }).catch(error => {
    expect(error).toMatchObject({ code: 'projection_unavailable' });
  });
  const after = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(after.revision).toBe(revision);
});

it('does not reenable a saved route changed while an automatic identity probe is pending', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runCommand.mockImplementationOnce(async () => { entered(); await gate; return { principal: 'fixture@example.invalid', loggedIn: true }; });
  const reading = f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  await pending;
  await f.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: f.input.harnessInstanceId, enabled: false, expectedRevision: before.revision, idempotencyKey: 'revocation-during-recovery' });
  release();
  const result = await reading;
  expect(result.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
  expect(JSON.parse(await readFile(f.store.configurationPath, 'utf8')).revision).toBe(before.revision + 1);
});

it('returns retryable unavailability on a failed repair, preserves the saved login, and recovers on retry', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  const apply = f.runtime.applyConfiguration.bind(f.runtime);
  vi.spyOn(f.runtime, 'applyConfiguration').mockRejectedValueOnce(new Error('synthetic-transient-failure')).mockImplementation(apply);
  const routes = createProviderSettingsRoutes({ store: f.store, getPrincipal: () => ({ userId: 'owner' }), canReadNativeAccountMetadata: () => true });
  const failed = await routes.request('/provider-settings');
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: { code: 'provider_settings_unavailable' } });
  const saved = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(saved.revision).toBe(before.revision);
  expect(saved.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId).enabled).toBe(true);
  const recovered = await routes.request('/provider-settings');
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId).enabled).toBe(true);
});

it('repairs through the Chat catalog and admits the same verified native principal without reconnect', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  const catalog = createChatProviderCatalogService({
    canRecoverNativeConnection: principal => principal.userId === 'owner',
    codingProviders: { invalidate() {}, listProviders: async () => [{ id: 'codex', kind: 'codex', displayName: 'Codex', availability: 'available', installStatus: 'installed', authStatus: 'unknown', supportedModes: ['default'], defaultMode: 'default', defaultModel: 'gpt-test', setupActions: [] }] },
    codingModelCatalogSource: async () => ({ models: [{ id: 'gpt-test', displayName: 'Test model', supportsVision: false, supportsToolUse: true, capabilities: ['tools'] }], options: [], defaultModel: 'gpt-test' }),
    agentRuntimeSource: async () => { throw new Error('No system runtime in fixture'); },
    harnessSettingsSource: f.store, executableDriverKinds: ['codex'],
  });
  // A collaborator can observe the existing status but cannot repair it.
  await catalog.getCatalog({ userId: 'collaborator', source: 'jwt' }, { instanceId: 'codex_default', model: 'gpt-test' });
  expect((await f.store.getSnapshot()).revision).toBe(before.revision);
  const result = await catalog.getCatalog({ userId: 'owner', source: 'jwt' }, { instanceId: 'codex_default', model: 'gpt-test' });
  expect(result.instances.find(row => row.id === 'codex_default')).toMatchObject({ availability: 'available' });
  const admission = createCodexExecutionAdmission({ homePath: f.home, isOwner: id => id === 'owner',
    getSnapshot: () => f.store.getSnapshot({ includeNativeAccountMetadata: true }), readNativeAccount: f.readMetadata });
  await expect(admission.start('owner', 'sess_repaired')).resolves.toEqual(expect.any(String));
  await expect(admission.validateLaunch('owner', 'sess_repaired')).resolves.toMatchObject({ expectedConsentRevision: before.revision + 1 });
  await expect(admission.start('collaborator')).rejects.toThrow('unavailable');
});

it('rejects a different principal observed between automatic discovery and completion', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  f.runCommand.mockImplementationOnce(async () => ({ principal: 'fixture@example.invalid', loggedIn: true }))
    .mockImplementationOnce(async () => { f.setPrincipal('replacement@example.invalid'); return { principal: 'replacement@example.invalid', loggedIn: true }; });
  const apply = vi.spyOn(f.runtime, 'applyConfiguration');
  await expect(f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true })).rejects.toMatchObject({ code: 'projection_unavailable' });
  const after = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  expect(after.revision).toBe(before.revision);
  expect(after.harnesses.find((row: {id: string}) => row.id === f.input.harnessInstanceId).nativeAccountGeneration).toBeUndefined();
  expect(apply).not.toHaveBeenCalled();
});

it('returns connected when another owner read repairs while its identity probe is delayed', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  let release!: () => void, entered!: () => void;
  const enteredProbe = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runCommand.mockImplementationOnce(async () => { entered(); await gate; return { principal: 'fixture@example.invalid', loggedIn: true }; });
  const delayed = f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  await enteredProbe;
  const immediate = await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  release();
  const recovered = await delayed;
  expect(recovered.revision).toBe(before.revision + 1);
  expect(recovered.revision).toBe(immediate.revision);
  expect(recovered.harnesses.find(row => row.id === f.input.harnessInstanceId)?.enabled).toBe(true);
});

it('preserves requested Claude account details and Codex usage in the first recovered Settings response', async () => {
  const f = await fixture(false, true); await saveLegacyNativeConnection(f);
  const recovered = await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  expect(recovered.accounts.find(row => row.id === 'owner_claude_profile')).toMatchObject({ authState: 'authenticated', connectionDetails: { email: 'claude@example.invalid', planName: 'Claude Max' } });
  expect(recovered.accessSources.find(row => row.id === 'owner_openai_profile')?.usage).toMatchObject({ kind: 'subscription_allowance', usedBasisPoints: 3700 });
  expect(recovered.harnesses.find(row => row.id === f.input.harnessInstanceId)?.enabled).toBe(true);
});

it('returns the newer saved state when revocation follows repair before the enriched response', async () => {
  const f = await fixture(); const before = await saveLegacyNativeConnection(f);
  const complete = f.store.completeCodexNativeLogin.bind(f.store);
  vi.spyOn(f.store, 'completeCodexNativeLogin').mockImplementationOnce(async input => {
    const result = await complete(input);
    await f.store.mutate({ type: 'set_harness_enabled', harnessInstanceId: f.input.harnessInstanceId, enabled: false,
      expectedRevision: result.snapshot.revision, idempotencyKey: 'revocation-after-repair' });
    return result;
  });
  const recovered = await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  expect(recovered.revision).toBe(before.revision + 2);
  expect(recovered.harnesses.find(row => row.id === f.input.harnessInstanceId)?.configuredEnabled).toBe(false);
});

it('does not publish a connected response when native proof is revoked after repair', async () => {
  const f = await fixture(); await saveLegacyNativeConnection(f);
  const complete = f.store.completeCodexNativeLogin.bind(f.store);
  vi.spyOn(f.store, 'completeCodexNativeLogin').mockImplementationOnce(async input => {
    const result = await complete(input); f.setLoggedIn(false); return result;
  });
  await expect(f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true })).rejects.toMatchObject({ code: 'projection_unavailable' });
});
