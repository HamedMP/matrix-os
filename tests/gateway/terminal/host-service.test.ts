import { createNativeTerminalHosts } from "../../../packages/terminal-runtime/src/native-host-lifecycle.js";
import { TerminalRuntimeSocketClient } from "../../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../../packages/terminal-runtime/src/socket-server.js";
import { createCanonicalTerminalLaunch } from "../../../packages/gateway/src/terminal/canonical-launch.js";
import { TerminalRuntime } from "../../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../../packages/terminal-runtime/src/workspace-store.js";
import { withTerminalGenerationLock } from "../../../packages/terminal-runtime/src/generation-lock.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalHostService } from "../../../packages/gateway/src/terminal/host-service.js";
import { terminalClosureFixture } from "../../helpers/terminal-closure.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(holdLaunch = false) {
  const root = await mkdtemp("/tmp/t7svc-"); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const closure = await terminalClosureFixture(); cleanup.push(() => rm(closure.dir, { recursive: true, force: true }));
  const runtimeRoot = join(root, "runtime"), dir = join(runtimeRoot, "generations", closure.generation); await mkdir(join(dir, ".."), { recursive: true }); await rename(closure.dir, dir);
  const home = join(root, "home"), namespaceRoot = join(root, "run"); await mkdir(home, { mode: 0o700 }); await mkdir(namespaceRoot, { mode: 0o700 });
  const uid = process.getuid!(), gid = process.getgid!(), supervisor = { pid: 10, ppid: 1, uid, gid, start: "10" }, host = { ...supervisor, pid: 20, ppid: 10, start: "20" }, nativeRoot = { ...host, pid: 30, ppid: 20, start: "30" };
  const units = new Map<string, boolean>(); let stopUncertain = true;
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[1] === "stop") { if (stopUncertain) throw new Error("Named manager stop uncertainty"); units.set(args[2]!, false); return { stdout: "", stderr: "" }; }
    return { stdout: args.filter(arg => arg.endsWith(".service")).map(unit => `Id=${unit}\nLoadState=${units.has(unit) ? "loaded" : "not-found"}\nActiveState=${units.get(unit) ? "active" : "inactive"}\nSubState=${units.get(unit) ? "running" : "dead"}\nMainPID=${units.get(unit) ? 10 : 0}\nInvocationID=${units.get(unit) ? "c".repeat(32) : ""}\n`).join("\n"), stderr: "" };
  });
  let releaseLaunch = () => {}; let started!: () => void; const launchStarted = new Promise<void>(resolve => { started = resolve; });
  const spawnPrivate = vi.fn((_command: string, args: string[]) => {
    const unit = args.find(arg => arg.startsWith("--unit="))!.slice(7); if (!holdLaunch) units.set(unit, true);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
    const digest = args.at(-1), wrapper = randomUUID(), shim = randomUUID(); let bytes = "";
    child.stdin.on("data", data => { bytes += data.toString(); let at; while ((at = bytes.indexOf("\n")) >= 0) {
      const frame = JSON.parse(bytes.slice(0, at)); bytes = bytes.slice(at + 1);
      if (frame.type === "host.terminal.admit") child.stdout.write(JSON.stringify({ type: "terminal.bound", admissionId: frame.admissionId, supervisor, host, root: nativeRoot, invocationId: "c".repeat(32), generation: closure.generation }) + "\n");
    } });
    releaseLaunch = () => { units.set(unit, true); queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "wrapper.ready", wrapper, shim, digest }) + "\n")); };
    started(); if (!holdLaunch) releaseLaunch();
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const options = { homePath: home, namespaceRoot, runtimeRoot, generation: closure.generation,
    generationLockHelperPath: resolve("distro/customer-vps/host-bin/matrix-terminal-generation-gc.py"), runCommand: run, spawnPrivate,
    readProcess: async (pid: number) => [supervisor, host, nativeRoot].find(value => value.pid === pid)! };
  const service = createTerminalHostService(options); cleanup.push(service.close);
  const launch = { command: "/bin/sh", args: [], cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home }, inheritEnv: false as const };
  return { service, options, home, units, run, spawnPrivate, launch, launchStarted, releaseLaunch: () => releaseLaunch(), confirmedStop: () => { stopUncertain = false; } };
}
it("retains ordinary I/O ownership on source failure and unknown stop, without restoring authority from descriptor", async () => {
  const f = await fixture(), onBound = vi.fn(async () => { throw new Error("No synthetic source authority"); });
  const result = await f.service.start({ launch: f.launch, cols: 80, rows: 24, onBound });
  expect(result.status).toBe("running"); expect(onBound).toHaveBeenCalledOnce();
  expect(Object.keys(result.reference)).toEqual(["path"]);
  const descriptorRoot = join(f.home, "system/terminal-runtimes"), name = (await readdir(descriptorRoot)).find(name => name.startsWith("native-"))!;
  const descriptor = JSON.parse(await readFile(join(descriptorRoot, name), "utf8"));
  expect(Object.keys(descriptor).sort()).toEqual(["version", "kind", "launchId", "generation", "createdAt", "directory", "launch", "cols", "rows"].sort());
  expect(await f.service.stop(result.reference)).toEqual({ status: "unknown" });
  expect(await readFile(join(descriptorRoot, name), "utf8")).toBeDefined();
  await f.service.close();
  const restored = createTerminalHostService(f.options); cleanup.push(restored.close);
  expect((await restored.inspect(result.reference)).status).toBe("running"); expect(onBound).toHaveBeenCalledOnce();
  expect(f.spawnPrivate).toHaveBeenCalledOnce(); // Restore does not relaunch/reprove from public metadata.
  f.confirmedStop(); expect(await restored.stop(result.reference)).toEqual({ status: "stopped" });
});
it("shutdown closes only private control and keeps manager workload running", async () => {
  const f = await fixture(); const result = await f.service.start({ launch: f.launch, cols: 80, rows: 24 });
  await f.service.close(); expect([...f.units.values()]).toEqual([true]);
  expect(f.run.mock.calls.some(([, args]) => args[1] === "stop")).toBe(false);
  const args = f.spawnPrivate.mock.calls[0]![1]; expect(args).toContain("--pipe"); expect(args).toContain("--property=KillMode=control-group");
  expect(args.at(-4)?.endsWith("/node")).toBe(true); expect(args.at(-3)?.endsWith("/terminal-service.mjs")).toBe(true);
  expect(result.reference.path).toMatch(/\/matrix-terminal-[a-f0-9]{32}\/io.sock$/);
});
it("limits retained proof to32 without imposing a32-workload creation ceiling", async () => {
  const f = await fixture(), onBound = vi.fn(async () => ({
    invoke: async () => ({ v: 1 as const, error: { code: "unavailable" as const, message: "Routine requests are temporarily unavailable." } }), end() {}, async close() {},
  }));
  for (let index = 0; index < 33; index++) expect((await f.service.start({ launch: f.launch, cols: 80, rows: 24, onBound })).status).toBe("running");
  expect(onBound).toHaveBeenCalledTimes(32); expect(f.spawnPrivate).toHaveBeenCalledTimes(33); expect([...f.units.values()].every(Boolean)).toBe(true);
  expect(f.run.mock.calls.some(([, args]) => args[1] === "stop")).toBe(false);
}, 15000);
it("retention removes only confirmed stopped old records and keeps live or unknown workloads", async () => {
  const f = await fixture();
  const first = await f.service.start({ launch: f.launch, cols: 80, rows: 24 });
  const second = await f.service.start({ launch: f.launch, cols: 80, rows: 24 });
  const descriptorRoot = join(f.home, "system/terminal-runtimes");
  const names = (await readdir(descriptorRoot)).filter(name => name.startsWith("native-"));
  for (const name of names) {
    const path = join(descriptorRoot, name), descriptor = JSON.parse(await readFile(path, "utf8"));
    descriptor.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60000).toISOString();
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
  }
  // A missing source callback closes the proof channels asynchronously.
  await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
  f.run.mockRejectedValueOnce(new Error("Named manager inventory unavailable"));
  await expect(f.service.sweep()).rejects.toThrow();
  expect((await readdir(descriptorRoot)).filter(name => name.startsWith("native-"))).toHaveLength(2);
  f.confirmedStop(); await f.service.stop(first.reference);
  await f.service.sweep(); await f.service.sweep();
  expect((await readdir(descriptorRoot)).filter(name => name.startsWith("native-"))).toHaveLength(1);
  expect((await f.service.inspect(second.reference)).status).toBe("running");
});

it("canonical preadmission failure prevents any native dispatch", async () => {
  const f = await fixture();
  await expect(f.service.start({ launch: f.launch, cols: 80, rows: 24,
    onPrepared: async () => { throw new Error("Named canonical admission failure"); },
  })).rejects.toMatchObject({ phase: "never-dispatched" });
  expect(f.spawnPrivate).not.toHaveBeenCalled(); expect(f.units.size).toBe(0);
});
it("retiring a held proof releases its slot while all native workloads remain alive", async () => {
  const f = await fixture(), held: import("../../../packages/gateway/src/terminal/retained-binding.js").RetainedTerminalStartup[] = [];
  const onBound = vi.fn(async (startup: import("../../../packages/gateway/src/terminal/retained-binding.js").RetainedTerminalStartup) => {
    held.push(startup); return { invoke: async () => ({ v: 1 as const, error: { code: "unavailable" as const, message: "Routine requests are temporarily unavailable." } }), end() {}, async close() {} };
  });
  for (let index = 0; index < 32; index++) await f.service.start({ launch: f.launch, cols: 80, rows: 24, onBound });
  held[0]!.retire(); held[0]!.retire();
  await f.service.start({ launch: f.launch, cols: 80, rows: 24, onBound });
  expect(onBound).toHaveBeenCalledTimes(33); expect(held[0]!.signal.aborted).toBe(true);
  expect([...f.units.values()].every(Boolean)).toBe(true); expect(f.spawnPrivate.mock.results.every(r => !r.value.kill.mock.calls.length)).toBe(true);
  expect(f.run.mock.calls.some(([, args]) => args[1] === "stop")).toBe(false);
}, 15000);

it("canonical admission may take the workspace generation lock before native dispatch", async () => {
  const f = await fixture(), descriptorRoot = join(f.home, "system", "terminal-runtimes");
  await mkdir(descriptorRoot, { recursive: true, mode: 0o700 });
  let admitted = false;
  await f.service.start({ launch: f.launch, cols: 80, rows: 24, onPrepared: async () => {
    await withTerminalGenerationLock({ helperPath: f.options.generationLockHelperPath, descriptorRoot, cwd: f.home, env: process.env }, async () => {
      expect(f.spawnPrivate).not.toHaveBeenCalled(); admitted = true;
    });
  } });
  expect(admitted).toBe(true); expect(f.spawnPrivate).toHaveBeenCalledOnce();
}, 20000);

it.each(["expiry", "failed join"])("canonical %s retires the actual held service channel while the root remains alive", async reason => {
  const f = await fixture(), held: import("../../../packages/gateway/src/terminal/retained-binding.js").RetainedTerminalStartup[] = [];
  const zellij = { ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => {
    if (reason === "failed join") throw new Error("Named pane failure"); return { tabId: 1, paneId: "terminal_1" };
  }), subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })), openAttachment: vi.fn() };
  const store = new TerminalWorkspaceStore({ homePath: f.home }), runtime = new TerminalRuntime({ store, zellij,
    nativeHosts: { attachCommand: async ref => ["/fixed/node", "/fixed/terminal-io-attach.mjs", ref.path], inspect: async () => ({ status: "running" }), stop: async () => ({ status: "unknown" }) } });
  cleanup.push(() => runtime.shutdown()); const workspace = await runtime.ensureWorkspace();
  const register = vi.fn(async () => { throw new Error("No synthetic positive source"); });
  const coordinator = createCanonicalTerminalLaunch({ homePath: f.home, generation: f.options.generation, runtime, computerId: "computer-current", ownerIds: ["clerk_actual"], interactiveHostEquivalent: true,
    host: { start: input => f.service.start({ ...input, onBound: async startup => { held.push(startup); return input.onBound?.(startup); } }) },
    launcher: { build: async () => f.launch }, readProcess: f.options.readProcess,
    routines: { runtime: { register }, binPath: "/fixed/matrix.mjs", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" } });
  cleanup.push(coordinator.close);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const work = coordinator.launch({ userId: "clerk_actual", source: "jwt" }, workspace.id, { name: "Claude", cwd: "", managedLaunch: { harness: "claude" } });
    if (reason === "failed join") await expect(work).rejects.toThrow("Named pane failure");
    else { await work; await vi.advanceTimersByTimeAsync(30 * 60000 + 1); }
    expect(held).toHaveLength(1); expect(held[0]!.signal.aborted).toBe(true);
    expect([...f.units.values()]).toEqual([true]); expect(register).not.toHaveBeenCalled();
    expect(f.run.mock.calls.some(([, args]) => args[1] === "stop")).toBe(false);
    expect((await store.listWorkspaces())[0]!.tabs).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

async function canonicalServiceFixture(holdLaunch = false) {
  const f = await fixture(holdLaunch), store = new TerminalWorkspaceStore({ homePath: f.home });
  const hosts = createNativeTerminalHosts({ homePath: f.home, namespaceRoot: f.options.namespaceRoot, runtimeRoot: f.options.runtimeRoot, runCommand: f.run });
  const zellij = { ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => ({ tabId: 1, paneId: "terminal_1" })),
    subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })), openAttachment: vi.fn(), findTabByInternalName: vi.fn(async () => undefined), closeTab: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}) };
  const runtime = new TerminalRuntime({ store, zellij, nativeHosts: hosts }); cleanup.push(() => runtime.shutdown());
  const server = new TerminalRuntimeSocketServer({ socketPath: f.home + "/r.sock", runtime }); await server.start(); cleanup.push(() => server.close());
  const client = new TerminalRuntimeSocketClient({ socketPath: f.home + "/r.sock" }), workspace = await client.ensureWorkspace();
  const register = vi.fn(async () => { throw new Error("No synthetic positive source"); });
  const coordinator = createCanonicalTerminalLaunch({ homePath: f.home, generation: f.options.generation, runtime: client, host: f.service,
    computerId: "computer-current", ownerIds: ["clerk_actual"], interactiveHostEquivalent: true, launcher: { build: async () => f.launch }, readProcess: f.options.readProcess,
    routines: { runtime: { register }, binPath: "/fixed/matrix.mjs", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" } });
  cleanup.push(coordinator.close);
  return { ...f, store, client, runtime, coordinator, workspace, register, start: () => coordinator.launch({ userId: "clerk_actual", source: "jwt" }, workspace.id,
    { name: "Claude", cwd: "", managedLaunch: { harness: "claude" } }) };
}
it.each(["closed service", "missing generation"])("proven predescriptor %s leaves a normally deletable non-workload canonical tab", async reason => {
  const f = await canonicalServiceFixture();
  if (reason === "closed service") await f.service.close();
  else await rm(join(f.options.runtimeRoot, "generations", f.options.generation), { recursive: true, force: true });
  await expect(f.start()).rejects.toThrow(); expect(f.spawnPrivate).not.toHaveBeenCalled();
  const tab = (await f.store.listWorkspaces())[0]!.tabs[0]!; expect(tab).toBeDefined();
  expect(tab.status).toBe("failed"); expect(tab.nativeHost).toBeUndefined(); expect(tab.exitCode).toBeNull();
  await expect(f.client.deleteTab({ workspaceId: f.workspace.id, tabId: tab.id })).resolves.toBeUndefined();
  expect((await f.store.listWorkspaces())[0]!.tabs).toHaveLength(0);
  await expect(f.client.deleteWorkspace(f.workspace.id, { confirmTerminate: true })).resolves.toBeUndefined();
});
it("public completion cannot drop recovery while the actual producer is held before native launch", async () => {
  const f = await canonicalServiceFixture(true), work = f.start(); let completionDenied = false, deleteDenied = false;
  await f.launchStarted;
  const tab = (await f.store.listWorkspaces())[0]!.tabs[0]!, ref = { workspaceId: f.workspace.id, tabId: tab.id };
  try {
    try { await f.client.completeNativeTab(ref, { expectedIncarnation: tab.incarnation!, nativeHost: { path: tab.nativeHost!.path, generation: tab.nativeHost!.generation }, attach: false } as never); }
    catch { completionDenied = true; }
    try { await f.client.deleteTab(ref); } catch { deleteDenied = true; }
  } finally { f.releaseLaunch(); }
  await work.catch(() => undefined);
  expect(completionDenied).toBe(true); expect(deleteDenied).toBe(true);
  expect(await f.store.getTab(ref)).toBeDefined(); expect([...f.units.values()]).toEqual([true]); expect(f.register).not.toHaveBeenCalled();
});

it("lost prepare response retains unknown canonical recovery with zero dispatch and no ID-based retry", async () => {
  const f = await canonicalServiceFixture(), original = f.client.prepareNativeTab.bind(f.client);
  vi.spyOn(f.client, "prepareNativeTab").mockImplementation(async (...args) => { await original(...args); throw new Error("Named lost prepare response"); });
  await expect(f.start()).rejects.toThrow(); expect(f.spawnPrivate).not.toHaveBeenCalled();
  const tab = (await f.store.listWorkspaces())[0]!.tabs[0]!;
  expect(tab.nativeHost?.dispatchPending).toBe(true);
  await f.coordinator.launch({ userId: "clerk_actual", source: "jwt" }, f.workspace.id, { tabId: tab.id, name: "Claude", cwd: "", managedLaunch: { harness: "claude" } });
  expect(f.spawnPrivate).not.toHaveBeenCalled(); expect(f.register).not.toHaveBeenCalled();
  expect((await f.store.getTab({ workspaceId: f.workspace.id, tabId: tab.id }))?.nativeHost?.dispatchPending).toBe(true);
});
it("possible dispatch failure stays unknown even when the manager currently has no unit", async () => {
  const f = await canonicalServiceFixture(); f.spawnPrivate.mockImplementation(() => { throw new Error("Named uncertain spawn boundary"); });
  const tab = await f.start();
  expect(f.spawnPrivate).toHaveBeenCalledOnce(); expect(tab.status).toBe("unavailable"); expect(tab.nativeHost?.dispatchPending).toBe(true);
  await expect(f.client.deleteTab({ workspaceId: f.workspace.id, tabId: tab.id })).rejects.toThrow();
  expect((await f.store.getTab({ workspaceId: f.workspace.id, tabId: tab.id }))?.nativeHost?.dispatchPending).toBe(true);
  expect(f.register).not.toHaveBeenCalled();
});
