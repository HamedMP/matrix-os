import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { AiProviderService } from "../../packages/gateway/src/ai-providers/service.js";
import { ProviderSettingsStore } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";
import { createProviderGenericHarnessCoordinator } from "../../packages/gateway/src/ai-providers/provider-generic-harness-coordinator.js";
import { createCodexNativeAccountMetadataReader } from "../../packages/gateway/src/ai-providers/codex-native-account-metadata.js";
import { createProviderTerminalLoginHandoff } from "../../packages/gateway/src/ai-providers/provider-terminal-login-handoff.js";
import { createNativeProviderProfileGuard } from "../../packages/gateway/src/ai-providers/native-provider-profile-guard.js";
import { createNativeProviderWorkflowRuntime } from "../../packages/gateway/src/server/native-provider-workflow-runtime.js";

const roots: string[] = [], closes: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const route = "/api/ai/provider-settings/workflows/v2";
const post = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
async function fixture(version = "0.162.1", mode = "success", metadataNow?: () => Date) {
  const root = await mkdtemp(join(tmpdir(), "codex-settings-runtime-")); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "runtime");
  await mkdir(join(prefix, "bin"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  const executable = join(prefix, "bin/codex");
  await writeFile(join(home, 'version'), version);
  await writeFile(join(home, 'requests'), '');
  // Synthetic public auth methods match qualified retained official schemas;
  // this fixture never invokes a provider, official binary or real profile.
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='--version'){console.log('codex-cli '+fs.readFileSync(path.join(process.env.HOME,'version'),'utf8'));process.exit(0)}
if(process.argv.slice(2).join(' ')!=='app-server --stdio')process.exit(2);
const profile=process.env.CODEX_HOME,auth=path.join(profile,'auth.json');
const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
fs.appendFileSync(path.join(process.env.HOME,'requests'),r.method+'\\n');
if(r.method==='initialize')send({id:r.id,result:{userAgent:'codex-cli/${version}'}});
if(r.method==='config/read')send({id:r.id,result:{config:{cli_auth_credentials_store:'file'}}});
if(r.method==='account/read'){
 const saved=fs.existsSync(auth)?JSON.parse(fs.readFileSync(auth,'utf8')):null;
 const account=saved?.auth_mode==='apikey'?{type:'apiKey'}:saved?{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}:null;
 send({id:r.id,result:{account,requiresOpenaiAuth:true}});
}
if(r.method==='account/rateLimits/read')send({id:r.id,result:{rateLimits:null,rateLimitsByLimitId:null}});
if(r.method==='account/login/start'){
 send({id:r.id,result:{type:'chatgptDeviceCode',loginId:'11111111-1111-4111-8111-111111111111',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}});
 if(['success','slow-success','rotate-on-release','rotate-before-persist','hold-release'].includes(${JSON.stringify(mode)}))setTimeout(()=>{fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh'}}),{mode:0o600});send({method:'account/login/completed',params:{loginId:'11111111-1111-4111-8111-111111111111',success:true,error:null}})},${mode === "slow-success" ? 500 : 50});
}
if(r.method==='account/login/cancel')send({id:r.id,result:{status:'canceled'}});
});`); await chmod(executable, 0o700);
  vi.stubEnv("MATRIX_NODE_PREFIX", prefix); vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  const driver = { id: "codex" as const, displayName: "Codex", installState: "installed" as const, kind: "cli" as const, health: "ready" as const, setupActions: [], capabilities: ["tools", "resume"] };
  const service = new AiProviderService({
    homePath: home, env: { OPENAI_API_KEY: "synthetic-independent-key" }, driverInventory: async () => [driver],
    ...(["local-only", "stale-local-observation", "native-api-key"].includes(mode) ? {
      codexLocalObservation: async () => {
        const checkedAt = Date.now() - (mode === "stale-local-observation" ? 6000 : 0);
        return { accessSourceId: "owner_openai_profile", state: "present_unverified" as const,
          checkedAt: new Date(checkedAt).toISOString(), staleAfter: new Date(checkedAt + 5000).toISOString() };
      },
    } : {}),
    ...(mode === "native-api-key" ? { codexNativeKeyReadiness: async () => ({
      state: "ready" as const, action: "none" as const, safeReason: null, checkedAt: new Date().toISOString(), staleAfter: null,
    }) } : {}),
  });
  closes.push(() => service.close());
  const generic = createProviderGenericHarnessCoordinator({ homePath: home, enabledCodingHarnesses: [], runtimeController: { update: async () => { throw new Error("No funded/system route"); } }, runtimeSource: async () => { throw new Error("No funded/system route"); } });
  const realGuard = createNativeProviderProfileGuard({ homePath: home, registry: { listProfileSessions: async () => [], get: async () => { throw Object.assign(new Error("No fixture Terminal"), { code: "session_not_found" }); }, observeAgentLiveness: async () => "stopped" } });
  const rotateGeneration = async () => writeFile(join(home, ".codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-replacement-same-email", refresh_token: "synthetic-replacement-refresh" } }), { mode: 0o600 });
  let signalProofReady!: () => void, resumeCompletion!: () => void;
  const proofReady = new Promise<void>(resolve => { signalProofReady = resolve; });
  const completionGate = new Promise<void>(resolve => { resumeCompletion = resolve; });
  const guard = { ...realGuard, acquire: async (...args: Parameters<typeof realGuard.acquire>) => {
    const release = await realGuard.acquire(...args);
    return async () => {
      if (mode === "hold-release") { signalProofReady(); await completionGate; }
      await release(); if (mode === "rotate-on-release") await rotateGeneration();
    };
  } };
  const rollback = vi.spyOn(generic, "rollbackConfiguration");
  const apply = generic.applyConfiguration.bind(generic);
  generic.applyConfiguration = async input => { await apply(input); if (mode === "rotate-before-persist" && input.codexNativeCompletion) await rotateGeneration(); };
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, "private"), providerSnapshotReader: service, runtimeCoordinator: generic,
    loginCoordinator: { supportedMethods: () => ["terminal"], startLogin: async () => { throw new Error("Settings device login must not start Terminal"); } },
    codexNativeAccountMetadataReader: createCodexNativeAccountMetadataReader({ executable, cwd: home, ...(metadataNow ? { now: metadataNow } : {}), environment: { HOME: home, CODEX_HOME: join(home, ".codex") } }),
  });
  const initial = await store.getSnapshot(), harness = initial.harnesses.find(row => row.harness === "codex")!;
  await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: "initial-off" });
  const configuration = JSON.parse(await readFile(store.configurationPath, "utf8"));
  Object.assign(configuration.harnesses.find((row: { id: string }) => row.id === harness.id), { accessSourceId: "owner_openai_key", selectedAccountId: "owner_openai" });
  await writeFile(store.configurationPath, JSON.stringify(configuration));
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn(async () => []), getCommandResult: vi.fn() };
  const handoff = createProviderTerminalLoginHandoff(store, async () => { throw new Error("No Terminal handoff for device login"); });
  // Observe real completion I/O without shortening it to vi.waitFor's default
  // one-second polling window. Every store call still executes unchanged.
  type CompletionBoundary = { kind: "revision_read"; revision: number }
    | { kind: "native_completion"; error?: unknown };
  let signalCompletionBoundary!: (boundary: CompletionBoundary) => void;
  const completionBoundary = new Promise<CompletionBoundary>(resolve => { signalCompletionBoundary = resolve; });
  const nativeCompletions = vi.fn(async (input: Parameters<NonNullable<typeof handoff.completeCodexNativeLogin>>[0]) => {
    try {
      if (mode === "rotate-before-completion") await rotateGeneration();
      if (mode === "off-before-completion") {
        await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false,
          expectedRevision: input.expectedRevision, idempotencyKey: "off-during-existing-connect" });
      }
      const result = await handoff.completeCodexNativeLogin!(input);
      signalCompletionBoundary({ kind: "native_completion" });
      return result;
    } catch (error: unknown) {
      signalCompletionBoundary({ kind: "native_completion", error });
      throw error;
    }
  });
  const workflowStore = {
    ...handoff,
    async getSnapshot(options?: Parameters<typeof handoff.getSnapshot>[0]) {
      const snapshot = await handoff.getSnapshot(options);
      if (mode === "hold-release" && options?.refresh && options.includeNativeAccountMetadata)
        signalCompletionBoundary({ kind: "revision_read", revision: snapshot.revision });
      return snapshot;
    },
    completeCodexNativeLogin: nativeCompletions,
  };
  const app = new Hono();
  const lifecycle = await createNativeProviderWorkflowRuntime({ app, homePath: home, ownerId: "owner", getPrincipal: c => c.req.header("x-test-actor") === "other" ? { userId: "other" } : { userId: "owner" }, store: workflowStore, terminal: terminal as never, profileGuard: guard, inventory: async () => ({ drivers: [driver] }) }); closes.push(lifecycle.close);
  return { app, store, home, executable, terminal, harness, guard, rollback, proofReady, resumeCompletion, rotateGeneration, completionBoundary, nativeCompletions,
    seedNativeLogin: (kind: "chatgpt" | "apikey" = "chatgpt") => writeFile(join(home, ".codex/auth.json"), JSON.stringify(kind === "chatgpt"
      ? { auth_mode: "chatgpt", tokens: { access_token: "synthetic-existing-access", refresh_token: "synthetic-existing-refresh" } }
      : { auth_mode: "apikey", OPENAI_API_KEY: "synthetic-existing-key" }), { mode: 0o600 }),
    setVersion: (value: string) => writeFile(join(home, 'version'), value) };
}

it.each(["success", "local-only"])("offers Codex reuse on an unqualified device-login version from %s evidence and binds only on owner action", async mode => {
  const f = await fixture("0.172.0", mode);
  await f.seedNativeLogin();
  const authPath = join(f.home, ".codex/auth.json");
  const authBefore = await readFile(authPath, "utf8");
  const before = await f.store.getSnapshot();
  const input = { harnessInstanceId: f.harness.id, optionId: "openai_existing_codex", idempotencyKey: "existing-owner-consent" };
  const denied = post(input);
  expect((await f.app.request(`${route}/start`, { ...denied, headers: { ...denied.headers, "x-test-actor": "other" } })).status).toBe(403);

  const [capability] = await (await f.app.request(`${route}/capabilities`)).json();
  expect(capability.loginMethods).toEqual(expect.arrayContaining(["existing_codex", "terminal"]));
  expect(capability.loginMethods).not.toContain("device_code");
  const option = { id: "openai_existing_codex", method: "existing_codex", providerId: "openai", authKind: "subscription",
    billingKind: "subscription", executionKind: "native", availability: "available" };
  expect(capability.connectionOptions).toContainEqual(option);
  const legacyRoute = route.replace(/\/v2$/, "");
  const [legacy] = await (await f.app.request(`${legacyRoute}/capabilities?connectionVersion=2`)).json();
  expect(legacy.loginMethods).toEqual(["terminal"]);
  const legacyStart = await f.app.request(legacyRoute, post({ harnessInstanceId: f.harness.id, kind: "login",
    method: "existing_codex", idempotencyKey: "legacy-existing-connect" }));
  expect(legacyStart.status).toBe(503);
  expect((await f.store.getSnapshot()).revision).toBe(before.revision);
  expect(f.nativeCompletions).not.toHaveBeenCalled();

  const response = await f.app.request(`${route}/start`, post(input));
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ state: "succeeded", connectionOption: option, terminalSessionId: null, deviceCode: null, authorizationUrl: null });
  expect(await (await f.app.request(`${route}/${receipt.id}`)).json()).toEqual(receipt);
  expect(await (await f.app.request(`${route}/start`, post(input))).json()).toEqual(receipt);
  expect(f.nativeCompletions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    harnessInstanceId: f.harness.id, expectedRevision: before.revision, verifyNativeAccount: expect.any(Function),
  }));
  const connected = await f.store.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  expect(connected.harnesses.find(row => row.id === f.harness.id)).toMatchObject({
    accessSourceId: "owner_openai_profile", selectedAccountId: "owner_codex", enabled: true,
  });
  expect(f.terminal.createTab).not.toHaveBeenCalled();
  expect(await readFile(authPath, "utf8")).toBe(authBefore);
  expect(await readFile(join(f.home, "requests"), "utf8")).not.toMatch(/account\/(login\/start|logout)/);
}, 15000);

it.each(["signed-out", "apikey"] as const)("keeps %s Codex off the explicit existing account path", async kind => {
  const f = await fixture("0.171.0");
  if (kind === "apikey") await f.seedNativeLogin(kind);
  const response = await f.app.request(`${route}/capabilities`);
  expect(response.status).toBe(200);
  const [capability] = await response.json();
  expect(capability.loginMethods).toEqual(expect.arrayContaining(["device_code", "terminal"]));
  expect(capability.connectionOptions).not.toContainEqual(expect.objectContaining({ id: "openai_existing_codex" }));
  const start = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_existing_codex", idempotencyKey: "existing-unavailable" }));
  expect(start.status).toBe(503);
  expect(f.nativeCompletions).not.toHaveBeenCalled();
  expect(f.terminal.createTab).not.toHaveBeenCalled();
  expect(await readFile(join(f.home, "requests"), "utf8")).not.toMatch(/account\/(login\/start|logout)/);
});

it.each([
  { mode: "rotate-before-completion", code: "invalid_route", revisionChange: 0 },
  { mode: "off-before-completion", code: "revision_conflict", revisionChange: 1 },
] as const)("preserves the saved source when existing Codex completion races $mode", async ({ mode, code, revisionChange }) => {
  const f = await fixture("0.172.0", mode);
  await f.seedNativeLogin();
  const before = await f.store.getSnapshot();
  const response = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_existing_codex", idempotencyKey: "existing-principal-changed" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "failed", safeFailure: "unavailable", terminalSessionId: null, deviceCode: null, authorizationUrl: null });
  expect(await f.completionBoundary).toMatchObject({ kind: "native_completion", error: { code } });
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(before.revision + revisionChange);
  expect(after.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
  expect(f.terminal.createTab).not.toHaveBeenCalled();
  expect(await readFile(join(f.home, "requests"), "utf8")).not.toMatch(/account\/(login\/start|logout)/);
}, 15000);

it("offers verification from a fresh local ChatGPT observation before any private probe but fails without a principal", async () => {
  const f = await fixture("0.172.0", "local-only");
  const before = await f.store.getSnapshot();
  expect(before.accessSources.find(source => source.id === "owner_openai_profile")?.localObservation?.state).toBe("present_unverified");
  const [capability] = await (await f.app.request(`${route}/capabilities`)).json();
  expect(capability.connectionOptions).toContainEqual(expect.objectContaining({ id: "openai_existing_codex", availability: "available" }));
  expect(await readFile(join(f.home, "requests"), "utf8")).toBe("");
  const response = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_existing_codex", idempotencyKey: "existing-no-principal" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "failed", safeFailure: "unavailable", terminalSessionId: null });
  expect(f.nativeCompletions).not.toHaveBeenCalled();
  expect(f.terminal.createTab).not.toHaveBeenCalled();
  expect(await readFile(join(f.home, "requests"), "utf8")).toContain("account/read");
  expect((await f.store.getSnapshot()).revision).toBe(before.revision);
});

it.each(["stale-local-observation", "native-api-key"] as const)("ignores the %s local hint for Codex reuse", async mode => {
  const f = await fixture("0.172.0", mode);
  if (mode === "native-api-key") await f.seedNativeLogin("apikey");
  const [capability] = await (await f.app.request(`${route}/capabilities`)).json();
  expect(capability.connectionOptions).not.toContainEqual(expect.objectContaining({ id: "openai_existing_codex" }));
});

it.each(["0.156.1", "0.162.1", "0.163.0", "0.164.0", "0.171.0"])("runs qualified %s Settings login through production HTTP composition, real native account/source commit, and natural receipt readback", async version => {
  const f = await fixture(version);
  const response = await f.app.request(`${route}/capabilities`);
  expect(response.status).toBe(200);
  const capabilities = await response.json();
  expect(capabilities[0].connectionOptions).toContainEqual(expect.objectContaining({ id: "openai_device_code", method: "device_code", availability: "available" }));
  const start = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "settings-connect" }));
  expect(start.status).toBe(200);
  const operation = await start.json();
  await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${operation.id}`)).json()).toMatchObject({ state: "succeeded", connectionOption: { id: "openai_device_code" }, terminalSessionId: null, deviceCode: null, authorizationUrl: null }), { timeout: 5000 });
  const connected = await f.store.getSnapshot({ includeNativeAccountMetadata: true });
  expect(connected.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ accessSourceId: "owner_openai_profile", selectedAccountId: "owner_codex", enabled: true, configuredEnabled: true });
  expect(connected.accounts.find(row => row.id === "owner_codex")).toMatchObject({ authMethod: "terminal", authState: "authenticated" });
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});


it.each(["0.156.2", "0.163.1", "0.164.1", "0.170.0", "0.171.1"])("keeps unqualified installed %s on Terminal without starting app-server login", async version => {
  const f = await fixture(version);
  const capabilities = await (await f.app.request(`${route}/capabilities`)).json();
  expect(capabilities[0].loginMethods).toEqual(["terminal"]);
  expect(capabilities[0].connectionOptions).not.toContainEqual(expect.objectContaining({ id: "openai_device_code" }));
  expect((await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "unqualified" }))).status).toBe(503);
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});

it.each([
  { mode: "scope", reason: "scope_unavailable", version: "unknown_version" },
  { mode: "version", reason: "unsupported_version", version: "0.172.0" },
  { mode: "stdout", reason: "unsupported_version", version: "unknown_version" },
  { mode: "stderr", reason: "unexpected_stderr", version: "0.171.0" },
  { mode: "process", reason: "version_process_failed", version: "0.171.0" },
] as const)("logs a private Codex qualification diagnostic for $mode with no process details", async ({ mode, reason, version }) => {
  const f = await fixture("0.172.0");
  if (mode === "scope") {
    vi.stubEnv("CODEX_HOME", join(f.home, "..", "private-profile-detail"));
  } else if (mode === "stdout") {
    await f.setVersion("0.172.0 private-probe-detail");
  } else if (mode === "stderr" || mode === "process") {
    await writeFile(f.executable, [
      "#!/bin/sh",
      "echo 'codex-cli 0.171.0'",
      "echo 'private-probe-detail' >&2",
      mode === "process" ? "exit 7" : "exit 0",
    ].join("\n"));
  }

  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const response = await f.app.request(`${route}/capabilities`);
    expect(response.status).toBe(200);
    const capabilities = await response.json();
    expect(capabilities[0].loginMethods).toEqual(["terminal"]);
    expect(JSON.stringify(capabilities)).not.toMatch(/scope_unavailable|unsupported_version|unexpected_stderr|version_process_failed|private-.*-detail/);
    expect(warn).toHaveBeenCalledWith("[provider-workflow] Codex Settings protocol unavailable:", reason, version);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-.*-detail/);
  } finally {
    warn.mockRestore();
  }
});

it.each(['start', 'writer-acquired'] as const)('rechecks exact 0.163.0 qualification at %s before native authentication', async boundary => {
  const f = await fixture('0.163.0');
  const acquire = f.guard.acquire.bind(f.guard);
  const release = vi.fn();
  const acquired = vi.spyOn(f.guard, 'acquire');
  if (boundary === 'start') await f.setVersion('0.163.1');
  else acquired.mockImplementationOnce(async (...args) => {
    const drain = await acquire(...args);
    await f.setVersion('0.163.1');
    return async () => { release(); await drain(); };
  });
  const response = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: 'openai_device_code', idempotencyKey: 'version-drift' }));
  if (boundary === 'start') { expect(response.status).toBe(503); expect(acquired).not.toHaveBeenCalled(); }
  else {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'failed', safeFailure: 'unavailable' });
    expect(acquired).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  }
  await expect(f.guard.assertReadable('codex')).resolves.toBeUndefined();
  expect(f.terminal.createTab).not.toHaveBeenCalled();
  expect(await readFile(join(f.home, 'requests'), 'utf8')).not.toContain('account/login/start');
  expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: 'owner_openai_key' });
});

it('recovers rotated same-email 0.163.0 native consent through explicit Settings reuse without another login', async () => {
  const f = await fixture('0.163.0');
  const start = async (idempotencyKey: string) => {
    const response = await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: 'openai_device_code', idempotencyKey }));
    expect(response.status).toBe(200);
    const operation = await response.json();
    await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${operation.id}`)).json()).toMatchObject({ state: 'succeeded', safeFailure: null }), { timeout: 5000 });
  };
  const snapshot = () => f.store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  const generation = async () => JSON.parse(await readFile(f.store.configurationPath, 'utf8')).harnesses
    .find((row: { id: string }) => row.id === f.harness.id).nativeAccountGeneration;
  await start('initial-generation');
  expect((await snapshot()).accessSources.find(row => row.id === 'owner_openai_profile')?.readiness.state).toBe('ready');
  const before = await generation();
  await f.rotateGeneration();
  // The existing native reader has a five-second cooldown. Observe bounded
  // synthetic readback; do not weaken that cache or the generation fence.
  await vi.waitFor(async () => {
    const rotated = await snapshot();
    expect(rotated.accessSources.find(row => row.id === 'owner_openai_profile')?.readiness.state).toBe('auth_required');
    expect(rotated.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ enabled: false, configuredEnabled: true });
  }, { timeout: 7000, interval: 250 });
  await start('accept-current-generation');
  const recovered = await snapshot();
  expect(recovered.accessSources.find(row => row.id === 'owner_openai_profile')?.readiness.state).toBe('ready');
  expect(recovered.harnesses.find(row => row.id === f.harness.id)).toMatchObject({
    enabled: true, configuredEnabled: true, accessSourceId: 'owner_openai_profile', selectedAccountId: 'owner_codex',
  });
  expect(await generation()).not.toBe(before);
  const methods = (await readFile(join(f.home, 'requests'), 'utf8')).split('\n');
  expect(methods.filter(method => method === 'account/login/start')).toHaveLength(1);
  expect(methods).not.toContain('account/logout');
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});
it("denies another owner before native device authentication", async () => {
  const f = await fixture();
  const request = post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "other-owner" });
  expect((await f.app.request(`${route}/start`, { ...request, headers: { ...request.headers, "x-test-actor": "other" } })).status).toBe(403);
  expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.harness.id)?.configuredEnabled).toBe(false);
});
it("cancels the official native operation before releasing its writer and preserves the previous source and Off", async () => {
  const f = await fixture("0.162.1", "pending");
  const started = await (await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "cancel-native" }))).json();
  await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${started.id}`)).json()).toMatchObject({ deviceCode: "ABCD-EFGHI" }));
  await expect(f.guard.assertReadable("codex")).rejects.toBeDefined();
  expect(await (await f.app.request(`${route}/${started.id}/cancel`, post({}))).json()).toMatchObject({ state: "cancelled", deviceCode: null, authorizationUrl: null });
  await expect(f.guard.assertReadable("codex")).resolves.toBeUndefined();
  expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
  const methods = await readFile(join(f.home, "requests"), "utf8");
  expect(methods).toContain("account/login/cancel"); expect(methods).not.toContain("account/logout");
});
it("does not let delayed Settings completion override an intervening owner Off", async () => {
  const f = await fixture("0.162.1", "hold-release");
  try {
    const input = { harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "late-completion" };
    const started = await (await f.app.request(`${route}/start`, post(input))).json();
    await f.proofReady;
    const before = await f.store.getSnapshot();
    await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: f.harness.id, enabled: false, expectedRevision: before.revision, idempotencyKey: "off-during-device-login" });
    expect(await (await f.app.request(`${route}/${started.id}`)).json()).toMatchObject({ state: "running" });
    f.resumeCompletion();
    expect(await f.completionBoundary).toMatchObject({ kind: "revision_read", revision: before.revision + 1 });
    await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${started.id}`)).json()).toMatchObject({ state: "failed", safeFailure: "unavailable" }));
    expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
    expect(await (await f.app.request(`${route}/start`, post(input))).json()).toMatchObject({ id: started.id, state: "failed" });
    expect(f.nativeCompletions).not.toHaveBeenCalled();
  } finally { f.resumeCompletion(); }
});

it.each(["rotate-on-release", "rotate-before-persist"])("rejects same-email native credential generation drift at %s and preserves saved source/Off", async mode => {
  const f = await fixture("0.162.1", mode);
  const before = await f.store.getSnapshot();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const started = await (await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "generation-fence" }))).json();
    expect(await f.completionBoundary).toMatchObject({ kind: "native_completion", error: { code: "invalid_route" } });
    await vi.waitFor(async () => {
      const receipt = await (await f.app.request(`${route}/${started.id}`)).json();
      expect(receipt).toMatchObject({ state: "failed", safeFailure: "unavailable" });
      expect(JSON.stringify(receipt)).not.toContain("invalid_route");
    });
    expect(warn).toHaveBeenCalledWith("[provider-workflow] Codex connection unavailable:", "ProviderSettingsStoreError", "invalid_route");
  } finally {
    warn.mockRestore();
  }
  const after = await f.store.getSnapshot();
  expect(after.revision).toBe(before.revision);
  if (mode === "rotate-before-persist") expect(f.rollback).toHaveBeenCalledOnce();
  else expect(f.rollback).not.toHaveBeenCalled();
  expect(after.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
});

it("cancels through public workflow after proof capture but before private completion dispatch without enabling the native source", async () => {
  const f = await fixture("0.162.1", "hold-release");
  try {
    const before = await f.store.getSnapshot();
    const started = await (await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "cancel-before-commit" }))).json();
    await f.proofReady;
    await expect(f.guard.assertReadable("codex")).rejects.toBeDefined();
    const cancelled = f.app.request(`${route}/${started.id}/cancel`, post({}));
    // Drain request/manager microtasks into the held completion cleanup.
    await new Promise<void>(resolve => setImmediate(resolve));
    f.resumeCompletion();
    expect(await (await cancelled).json()).toMatchObject({ state: "cancelled", deviceCode: null, authorizationUrl: null });
    await expect(f.guard.assertReadable("codex")).resolves.toBeUndefined();
    const after = await f.store.getSnapshot();
    expect(after.revision).toBe(before.revision);
    expect(after.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
    expect(f.rollback).not.toHaveBeenCalled();
  } finally { f.resumeCompletion(); }
});

it("commits immediate native completion after a signed-out metadata preflight inside quota cooldown", async () => {
  const clock=new Date(); const f=await fixture("0.163.0","success",()=>clock);
  await f.store.getSnapshot({includeNativeAccountMetadata:true,includeNativeAccountUsage:false});
  const start=await f.app.request(`${route}/start`,post({harnessInstanceId:f.harness.id,optionId:"openai_device_code",idempotencyKey:"immediate-after-cold-metadata"}));
  expect(start.status).toBe(200); const operation=await start.json();
  await vi.waitFor(async()=>expect(await(await f.app.request(`${route}/${operation.id}`)).json()).toMatchObject({state:"succeeded",safeFailure:null}),{timeout:5000});
  const connected=await f.store.getSnapshot({includeNativeAccountMetadata:true,includeNativeAccountUsage:false});
  expect(connected.harnesses.find(row=>row.id===f.harness.id)).toMatchObject({configuredEnabled:true,enabled:true,accessSourceId:"owner_openai_profile",selectedAccountId:"owner_codex"});
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});

it('automatically repairs saved native bookkeeping through real app-server identity reads without starting login', async () => {
  const f = await fixture();
  await writeFile(join(f.home, '.codex/auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-existing-access', refresh_token: 'synthetic-existing-refresh' } }), { mode: 0o600 });
  const before = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  Object.assign(before.harnesses.find((row: {id: string}) => row.id === f.harness.id), { enabled: true, accessSourceId: 'owner_openai_profile', selectedAccountId: 'owner_codex' });
  await writeFile(f.store.configurationPath, JSON.stringify(before));
  const authBefore = await readFile(join(f.home, '.codex/auth.json'), 'utf8');
  const recovered = await f.store.getSnapshot({ includeNativeAccountMetadata: true, recoverNativeConnection: true });
  expect(recovered.harnesses.find(row => row.id === f.harness.id)).toMatchObject({ enabled: true, authState: 'authenticated' });
  expect(recovered.revision).toBe(before.revision + 1);
  expect(await readFile(join(f.home, '.codex/auth.json'), 'utf8')).toBe(authBefore);
  const requests = await readFile(join(f.home, 'requests'), 'utf8');
  expect(requests).toContain('account/read'); expect(requests).toContain('config/read');
  expect(requests).not.toContain('account/login/start');
  expect(f.terminal.createTab).not.toHaveBeenCalled();
});
