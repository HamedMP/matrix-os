import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPiSettingsConnection, PI_SETTINGS_AUTH_WORKER } from "../../packages/gateway/src/ai-providers/pi-settings-auth.js";
import type { OpenCodeProcess } from "../../packages/gateway/src/coding-agents/opencode-provider.js";
import {createGenericNativeWriter, guardGenericNativeKeys} from "../../packages/gateway/src/ai-providers/generic-native-writer.js";
function native(autoComplete = true) {
  const children: Array<EventEmitter & OpenCodeProcess & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } }> = [];
  const spawn = vi.fn((_command: string, args: string[]) => {
    const child = new EventEmitter() as typeof children[number]; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: vi.fn(), on: vi.fn() };
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit("exit", 1)); return true; }); children.push(child);
    setTimeout(() => {
      const mode = args.at(-1);
      if (mode === "probe") { child.stdout.emit("data", Buffer.from('{"type":"capability","supported":true}\n')); child.emit("exit", 0); }
      else { if (mode === "oauth") child.stdout.emit("data", Buffer.from('{"type":"device_code","code":"TEST-CODE","url":"https://auth.openai.com/codex/device"}\n'));
        if (autoComplete) { child.stdout.emit("data", Buffer.from('{"type":"completed"}\n')); child.emit("exit", 0); } }
    }, 0); return child;
  });
  return { spawn, children };
}
const config = { node: "/runtime/bin/node", entry: "file:///runtime/pi/dist/index.js", cwd: "/owner", env: { HOME: "/owner" } };
const request = { kind: "login" as const, method: "device_code" as const, harnessInstanceId: "pi", idempotencyKey: "pi-connect-key" };
it("retains production key admission until actual Pi exit and route activation",async()=>{
 const {mkdir,mkdtemp,rm}=await import("node:fs/promises"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
 const root=await mkdtemp(join(tmpdir(),"pi-guarded-key-")),home=join(root,"home"); await mkdir(home);
 const n=native(false); let commit!:()=>void;
 const enableConnected=vi.fn(()=>new Promise<void>(resolve=>{commit=resolve;}));
 const writer=createGenericNativeWriter(home);
 const connection=guardGenericNativeKeys(writer,"pi",createPiSettingsConnection({discover:async()=>config,spawn:n.spawn,enableConnected,fetch:async()=>new Response(null,{status:200})}));
 try {
   const running=connection.verifyKey({harnessInstanceId:"pi",providerId:"anthropic",apiKey:"synthetic"});
   await vi.waitFor(()=>expect(n.children).toHaveLength(1));
   n.children[0]!.stdout.emit("data",Buffer.from('{"type":"completed"}\n'));
   await expect(createGenericNativeWriter(home).run("pi",async()=>{})).rejects.toThrow();
   expect(enableConnected).not.toHaveBeenCalled();
   n.children[0]!.emit("exit",0);
   await vi.waitFor(()=>expect(enableConnected).toHaveBeenCalledOnce());
   await expect(createGenericNativeWriter(home).run("pi",async()=>{})).rejects.toThrow();
   commit(); await running;
   await expect(createGenericNativeWriter(home).run("pi",async()=>"next")).resolves.toBe("next");
 } finally {await connection.close(); await rm(root,{recursive:true,force:true});}
});
it.each([true, false])("qualifies the fixed public provider methods with empty read-only credentials (%s)", async supported => {
  const { execFile } = await import("node:child_process"); const { promisify } = await import("node:util");
  const entry = `data:text/javascript,${encodeURIComponent(`export class ModelRuntime {
    static async create(options) { if (!options.credentials || await options.credentials.read('openai') !== undefined || (await options.credentials.list()).length || options.allowModelNetwork !== false) throw new Error('unsafe'); return new ModelRuntime(); }
    login() {} getProvider(id) { return ${supported ? "true" : "id !== 'anthropic'"} ? {auth:{apiKey:{login(){}}}} : {}; }
  }`)}`;
  const task = promisify(execFile)(process.execPath, ["--input-type=module", "--eval", PI_SETTINGS_AUTH_WORKER, entry, "probe"], { timeout: 5000, maxBuffer: 4096 });
  if (supported) expect((await task).stdout).toBe('{"type":"capability","supported":true}\n');
  else await expect(task).rejects.toMatchObject({ code: 1, stdout: '{"type":"failed"}\n' });
});
describe("Pi sanctioned Settings auth", () => {
  it("coalesces SDK capability probes and fails closed for an unsupported installed runtime", async () => {
    const n = native(); const discover = vi.fn().mockResolvedValue(config);
    const connection = createPiSettingsConnection({ discover, spawn: n.spawn, enableConnected: vi.fn() });
    expect(await Promise.all([connection.capabilities(), connection.capabilities()])).toEqual([{ login: true, apiKey: true }, { login: true, apiKey: true }]); expect(n.spawn).toHaveBeenCalledOnce(); await connection.close();
    const unsupported = createPiSettingsConnection({ discover: async () => { throw new Error("unsupported version"); }, spawn: n.spawn, enableConnected: vi.fn() });
    await expect(unsupported.capabilities()).rejects.toThrow(); expect(n.spawn).toHaveBeenCalledOnce();
  });
  it("uses only public SDK callbacks and enables the exact native OAuth route after confirmed child exit", async () => {
    const n = native(); const enableConnected = vi.fn(); const publish = vi.fn();
    const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected });
    await connection.start({ registerCleanup: () => {},  request, publish }); await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null }));
    expect(publish).toHaveBeenCalledWith({ deviceCode: "TEST-CODE", authorizationUrl: "https://auth.openai.com/codex/device" });
    expect(enableConnected).toHaveBeenCalledWith("pi", "openai-codex", expect.stringMatching(/^pi-connect-[a-f0-9]{64}$/));
    expect(PI_SETTINGS_AUTH_WORKER).toContain('runtime.login(mode==="key"?provider:"openai-codex"'); expect(PI_SETTINGS_AUTH_WORKER).not.toContain("readFile"); await connection.close();
  });
  it("cancels and drains the native process without enabling or publishing success", async () => {
    const n = native(false); const enableConnected = vi.fn(); const publish = vi.fn();
    const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected });
    const active = await connection.start({ registerCleanup: () => {},  request, publish }); await active.cancel();
    expect(n.children[0]!.kill).toHaveBeenCalledWith("SIGTERM"); expect(enableConnected).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" })); await connection.close();
  });
  it("shutdown awaits child termination and blocks future native sessions", async () => {
    const n = native(false); const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected: vi.fn() });
    await connection.start({ registerCleanup: () => {},  request, publish: vi.fn() }); await connection.close(); expect(n.children[0]!.kill).toHaveBeenCalledWith("SIGTERM"); await expect(connection.start({ registerCleanup: () => {},  request, publish: vi.fn() })).rejects.toThrow("unavailable");
  });
  it("handles a native failure without leaking output or enabling the route", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const n = native(false); const enableConnected = vi.fn(); const publish = vi.fn();
    const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected });
    try {
      await connection.start({ registerCleanup: () => {},  request, publish });
      n.children[0]!.stderr.emit("data", Buffer.from("credential-private-error"));
      n.children[0]!.stdout.emit("data", Buffer.from('{"type":"failed"}\n'));
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: "failed", safeFailure: "unavailable" }));
      expect(warning).toHaveBeenCalledWith("[provider-workflow] Pi native task failed:", "workflow_failure");
      expect(JSON.stringify([warning.mock.calls, publish.mock.calls])).not.toContain("credential-private-error");
      expect(enableConnected).not.toHaveBeenCalled();
      expect(n.children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    } finally { await connection.close(); warning.mockRestore(); }
  });
  it("rejects a bad key before native persistence and passes a good key only over stdin", async () => {
    const n = native(); const enableConnected = vi.fn(); const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected, fetch });
    await expect(connection.verifyKey({ harnessInstanceId: "pi", providerId: "openai", apiKey: "test-secret" })).rejects.toThrow("rejected"); expect(n.spawn).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response(null, { status: 200 })); await connection.verifyKey({ harnessInstanceId: "pi", providerId: "openai", apiKey: "test-secret" });
    expect(n.children[0]!.stdin.end).toHaveBeenCalledWith('{"key":"test-secret"}'); expect(JSON.stringify(n.spawn.mock.calls[0])).not.toContain("test-secret"); expect(enableConnected).toHaveBeenCalledWith("pi", "openai", expect.any(String)); await connection.close();
  });
});

it.each([
  ['throw new Error("credential-private-error")', "sdk_failure"],
  ['throw "credential-private-error"', "unexpected_failure"],
  ['throw new DOMException("credential-private-error", "AbortError")', "cancelled"],
])("classifies native SDK failures and logs only a fixed category (%s)", async (failure, category) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const entry = `data:text/javascript,${encodeURIComponent(`export class ModelRuntime { static async create() { return new ModelRuntime(); } async login() { ${failure}; } }`)}`;
  let result: unknown;
  try { await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", PI_SETTINGS_AUTH_WORKER, entry, "oauth"], { timeout: 5000, maxBuffer: 8192 }); }
  catch (error) { result = error; }
  expect(result).toMatchObject({ code: 1, stdout: '{"type":"failed"}\n', stderr: `[provider-workflow] Pi native authentication failed: ${category}\n` });
});

it.each(["0.99.2", "1.0.0"])("discovers only the verified managed Pi %s package and strips operator credentials", async version => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
  const { discoverPiSettingsAuth } = await import("../../packages/gateway/src/ai-providers/pi-settings-auth.js");
  const prefix = await mkdtemp(join(tmpdir(), "pi-settings-public-"));
  try {
    const root = join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent"); await mkdir(join(root, "dist/bundle"), { recursive: true }); await mkdir(join(prefix, "bin"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
    await writeFile(join(root, "dist/index.js"), "export class ModelRuntime {}\n");
    await writeFile(join(root, "dist/bundle/cli.js"), `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 }); await symlink(join(root, "dist/bundle/cli.js"), join(prefix, "bin/pi"));
    const result = await discoverPiSettingsAuth({ homePath: prefix, runtimePrefix: prefix, env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "operator-secret", PI_CODING_AGENT_DIR: "/operator" } });
    expect(result.env).toEqual({ HOME: prefix, MATRIX_HOME: prefix, PATH: "/usr/bin:/bin" }); expect(result.entry).toContain("/dist/index.js");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.61.0" }));
    await expect(discoverPiSettingsAuth({ homePath: prefix, runtimePrefix: prefix, env: {} })).rejects.toThrow();
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

it("bounds an unfinished device flow and publishes expiry only after process cleanup", async () => {
  vi.useFakeTimers();
  try {
    const n = native(false); const publish = vi.fn(); const enableConnected = vi.fn();
    const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected });
    await connection.start({ registerCleanup: () => {},  request, publish }); await vi.advanceTimersByTimeAsync(600001);
    expect(n.children[0]!.kill).toHaveBeenCalledWith("SIGTERM"); expect(publish).toHaveBeenCalledWith({ state: "expired", safeFailure: "expired" }); expect(enableConnected).not.toHaveBeenCalled(); await connection.close();
  } finally { vi.useRealTimers(); }
});
it('waits for an already committing connection before cancellation returns', async () => {
  const n = native(); let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const enableConnected = vi.fn(() => gate); const publish = vi.fn();
  const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected });
  const running = await connection.start({ registerCleanup: () => {}, request, publish });
  await vi.waitFor(() => expect(enableConnected).toHaveBeenCalledOnce());
  const cancelling = running.cancel();
  expect(await Promise.race([cancelling.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 20))])).toBe(false);
  finish(); await cancelling;
  expect(publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }); await connection.close();
});

it.each(["anthropic", "openrouter"] as const)("saves %s using the native provider API without exposing the key", async providerId => {
  const n = native(); const enableConnected = vi.fn(); const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  const connection = createPiSettingsConnection({ discover: async () => config, spawn: n.spawn, enableConnected, fetch });
  await connection.verifyKey({ harnessInstanceId: "pi", providerId, apiKey: "test-secret" });
  expect(n.children[0]!.stdin.end).toHaveBeenCalledWith(JSON.stringify({ key: "test-secret", provider: providerId }));
  expect(enableConnected).toHaveBeenCalledWith("pi", providerId, expect.any(String));
  expect(JSON.stringify(n.spawn.mock.calls)).not.toContain("test-secret");
  await connection.close();
});
