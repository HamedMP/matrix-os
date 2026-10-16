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
async function fixture(version = "0.162.1", mode = "success") {
  const root = await mkdtemp(join(tmpdir(), "codex-settings-runtime-")); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "runtime");
  await mkdir(join(prefix, "bin"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true, mode: 0o700 });
  const executable = join(prefix, "bin/codex");
  // Implements only the public rust-v0.162.1 methods independently qualified
  // against the official binary schema. Never invokes a provider or real profile.
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='--version'){console.log('codex-cli ${version}');process.exit(0)}
if(process.argv.slice(2).join(' ')!=='app-server --stdio')process.exit(2);
const profile=process.env.CODEX_HOME,auth=path.join(profile,'auth.json');
const send=x=>console.log(JSON.stringify(x));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
fs.appendFileSync(path.join(process.env.HOME,'requests'),r.method+'\\n');
if(r.method==='initialize')send({id:r.id,result:{userAgent:'codex-cli/0.162.1'}});
if(r.method==='config/read')send({id:r.id,result:{config:{cli_auth_credentials_store:'file'}}});
if(r.method==='account/read')send({id:r.id,result:{account:fs.existsSync(auth)?{type:'chatgpt',email:'fixture@example.invalid',planType:'plus'}:null,requiresOpenaiAuth:true}});
if(r.method==='account/rateLimits/read')send({id:r.id,result:{rateLimits:null,rateLimitsByLimitId:null}});
if(r.method==='account/login/start'){
 send({id:r.id,result:{type:'chatgptDeviceCode',loginId:'11111111-1111-4111-8111-111111111111',verificationUrl:'https://auth.openai.com/codex/device',userCode:'ABCD-EFGHI'}});
 if(['success','slow-success','rotate-on-release','rotate-before-persist','hold-release'].includes(${JSON.stringify(mode)}))setTimeout(()=>{fs.writeFileSync(auth,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh'}}),{mode:0o600});send({method:'account/login/completed',params:{loginId:'11111111-1111-4111-8111-111111111111',success:true,error:null}})},${mode === "slow-success" ? 500 : 50});
}
if(r.method==='account/login/cancel')send({id:r.id,result:{status:'canceled'}});
});`); await chmod(executable, 0o700);
  vi.stubEnv("MATRIX_NODE_PREFIX", prefix); vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  const driver = { id: "codex" as const, displayName: "Codex", installState: "installed" as const, kind: "cli" as const, health: "ready" as const, setupActions: [], capabilities: ["tools", "resume"] };
  const service = new AiProviderService({ homePath: home, env: { OPENAI_API_KEY: "synthetic-independent-key" }, driverInventory: async () => [driver] }); closes.push(() => service.close());
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
    codexNativeAccountMetadataReader: createCodexNativeAccountMetadataReader({ executable, cwd: home, environment: { HOME: home, CODEX_HOME: join(home, ".codex") } }),
  });
  const initial = await store.getSnapshot(), harness = initial.harnesses.find(row => row.harness === "codex")!;
  await store.mutate({ type: "set_harness_enabled", harnessInstanceId: harness.id, enabled: false, expectedRevision: initial.revision, idempotencyKey: "initial-off" });
  const configuration = JSON.parse(await readFile(store.configurationPath, "utf8"));
  Object.assign(configuration.harnesses.find((row: { id: string }) => row.id === harness.id), { accessSourceId: "owner_openai_key", selectedAccountId: "owner_openai" });
  await writeFile(store.configurationPath, JSON.stringify(configuration));
  const terminal = { ensureWorkspace: vi.fn(), createTab: vi.fn(), terminateTab: vi.fn(), attach: vi.fn(), listWorkspaces: vi.fn(async () => []), getCommandResult: vi.fn() };
  const handoff = createProviderTerminalLoginHandoff(store, async () => { throw new Error("No Terminal handoff for device login"); });
  const app = new Hono();
  const lifecycle = await createNativeProviderWorkflowRuntime({ app, homePath: home, ownerId: "owner", getPrincipal: c => c.req.header("x-test-actor") === "other" ? { userId: "other" } : { userId: "owner" }, store: handoff, terminal: terminal as never, profileGuard: guard, inventory: async () => ({ drivers: [driver] }) }); closes.push(lifecycle.close);
  return { app, store, home, terminal, harness, guard, rollback, proofReady, resumeCompletion };
}

it.each(["0.156.1", "0.162.1"])("runs qualified %s Settings login through production HTTP composition, real native account/source commit, and natural receipt readback", async version => {
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


it("keeps unqualified installed versions on Terminal without starting app-server login", async () => {
  const f = await fixture("0.156.2");
  const capabilities = await (await f.app.request(`${route}/capabilities`)).json();
  expect(capabilities[0].loginMethods).toEqual(["terminal"]);
  expect(capabilities[0].connectionOptions).not.toContainEqual(expect.objectContaining({ id: "openai_device_code" }));
  expect((await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "unqualified" }))).status).toBe(503);
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
  const f = await fixture("0.162.1", "slow-success");
  const input = { harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "late-completion" };
  const started = await (await f.app.request(`${route}/start`, post(input))).json();
  const before = await f.store.getSnapshot();
  await f.store.mutate({ type: "set_harness_enabled", harnessInstanceId: f.harness.id, enabled: false, expectedRevision: before.revision, idempotencyKey: "off-during-device-login" });
  await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${started.id}`)).json()).toMatchObject({ state: "failed", safeFailure: "unavailable" }));
  expect((await f.store.getSnapshot()).harnesses.find(row => row.id === f.harness.id)).toMatchObject({ configuredEnabled: false, configuredAccessSourceId: "owner_openai_key" });
  expect(await (await f.app.request(`${route}/start`, post(input))).json()).toMatchObject({ id: started.id, state: "failed" });
});

it.each(["rotate-on-release", "rotate-before-persist"])("rejects same-email native credential generation drift at %s and preserves saved source/Off", async mode => {
  const f = await fixture("0.162.1", mode);
  const before = await f.store.getSnapshot();
  const started = await (await f.app.request(`${route}/start`, post({ harnessInstanceId: f.harness.id, optionId: "openai_device_code", idempotencyKey: "generation-fence" }))).json();
  await vi.waitFor(async () => expect(await (await f.app.request(`${route}/${started.id}`)).json()).toMatchObject({ state: "failed", safeFailure: "unavailable" }));
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
