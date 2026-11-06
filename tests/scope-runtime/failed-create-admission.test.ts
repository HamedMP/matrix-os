import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DirectoryChildRequest } from "../../packages/scope-runtime/src/inherited-command-directory.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { createScopeRuntimeController } from "../../packages/scope-runtime/src/supervisor.js";
import { commandIdentityFixture, portableDirectoryChild } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const handle = (index: number) => `runtime_${index.toString(16).padStart(32, "0")}`;
const suffix = (index: number) => handle(index).slice(8);
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(namespaced = true, maxRuntimes = 32) {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = commandIdentityFixture(root), stateRoot = join(root, "s"), commandSocketRoot = namespaced ? join(root, "c") : undefined;
  await identity.directoryOperations.prepareAnchors!({ stateRoot, commandSocketRoot });
  for (const name of ["sdk.mjs", "worker.js", "claude", "codex"]) await writeFile(join(root, name), "export {};\n");
  for (const name of ["claude", "codex"]) await chmod(join(root, name), 0o755);
  const broker = createServer(), brokerSocket = join(root, "broker.sock");
  await new Promise<void>(resolve => broker.listen(brokerSocket, resolve));
  cleanup.push(() => new Promise<void>(resolve => broker.close(() => resolve())));
  const units = new Map<string, string>(); // Fixture unit inventory is capped to32 below.
  const state = { fail: true, childGate: undefined as Promise<void> | undefined, activeGate: undefined as Promise<void> | undefined, observeGate: undefined as Promise<void> | undefined, recoveryBlocked: false };
  const child = vi.fn(async (request: DirectoryChildRequest) => {
    await portableDirectoryChild(request);
    if (state.childGate) await state.childGate;
    if (state.fail) throw new Error("uncertain creator result");
  });
  const execute = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === join(root, "codex")) return { stdout: "codex-cli 0.162.1\n" };
    if (command === "/usr/bin/systemd-run") {
      const unit = args.find(arg => arg.startsWith("--unit="))!.slice(7);
      const runtimeRoot = args.find(arg => arg.startsWith("--property=RootDirectory="))!.slice("--property=RootDirectory=".length).replace(/\/root$/, "");
      expect(units.size).toBeLessThan(32); units.set(unit, runtimeRoot);
      await writeFile(join(runtimeRoot, "ready"), `runtime_${runtimeRoot.split("/").at(-1)}\n`); return { stdout: "" };
    }
    if (args[0] === "list-units") {
      if (args.includes("--state=active") && state.activeGate) await state.activeGate;
      return { stdout: [...units.keys()].map(unit => `${unit} loaded active running`).join("\n") };
    }
    if (args[0] === "show") {
      if (state.observeGate) await state.observeGate;
      const unit = args[1]!, runtimeRoot = units.get(unit);
      return { stdout: Object.entries({ Id: unit, LoadState: runtimeRoot ? "loaded" : "not-found", ActiveState: runtimeRoot ? "active" : "inactive",
        SubState: runtimeRoot ? "running" : "dead", MainPID: runtimeRoot || state.recoveryBlocked ? "42" : "0", ControlPID: "0",
        ControlGroup: runtimeRoot ? `/system.slice/${unit}` : "", KillMode: "control-group", RootDirectory: runtimeRoot ? join(runtimeRoot, "root") : "" })
        .map(([key, value]) => `${key}=${value}`).join("\n") };
    }
    if (args[0] === "stop") units.delete(args[1]!);
    return { stdout: "active\n" };
  });
  const launcher = createSystemdScopeRuntimeLauncher({ ...identity, ...(namespaced ? { namespace: "failed-create", commandSocketRoot } : {}),
    stateRoot, sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "worker.js"), brokerSocket,
    nodeBinary: process.execPath, codexBinary: join(root, "codex"), runCommand: execute,
    directoryOperations: { ...identity.directoryOperations, runChild: child } });
  let next = 1, request = 1;
  async function controller() {
    const result = await createScopeRuntimeController({ launcher, executionGeneration: "1", maxRuntimes, createRuntimeHandle: () => handle(next++) });
    cleanup.push(() => result.close()); return result;
  }
  const create = (owner: Awaited<ReturnType<typeof controller>>) => owner.handle({ version: 1, type: "runtime.create",
    requestId: `018f0ce5-7b4a-7f95-a7c8-${String(request++).padStart(12, "0")}`, scopeHandle: "scope_" + "a".repeat(32),
    profileId: "scope-runtime-chat-v1", workload: "chat_ai", adapterId: "claude-code", harnessVersion: "2.1.240" });
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  return { root, stateRoot, commandSocketRoot, controller, create, child, execute, state, warnings,
    exitAll: () => units.clear(),
    roots: () => readdir(join(stateRoot, "runtimes")), commandPath: (index: number) => commandSocketRoot
      ? join(commandSocketRoot, suffix(index)) : join(stateRoot, "runtimes", suffix(index), "command") };
}

it.each([false, true])("bounds sequential uncertain failed creates until verified startup reconciliation (namespaced=%s)", async namespaced => {
  const f = await fixture(namespaced), owner = await f.controller();
  for (let i = 0; i < 130; i++) await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(await f.roots()).toEqual([suffix(1)]); expect(f.child).toHaveBeenCalledOnce();
  expect(f.warnings).toHaveBeenCalledExactlyOnceWith("[scope-runtime] fixed-profile launch failed:", "Error");
  await owner.close();
  f.state.recoveryBlocked = true;
  await expect(f.controller()).rejects.toThrow("Unsafe scope runtime cleanup ownership");
  expect(await f.roots()).toEqual([suffix(1)]);
  f.state.recoveryBlocked = false; f.state.fail = false;
  const recovered = await f.controller();
  expect(await f.roots()).toEqual([]);
  await expect(lstat(f.commandPath(1))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(f.create(recovered)).resolves.toMatchObject({ ok: true, runtimeHandle: handle(2) });
});

it("bounds already-admitted failures to32 entries per root and drains active/queued work at shutdown", async () => {
  const f = await fixture(), blocker = gate(); f.state.childGate = blocker.promise;
  const owner = await f.controller(), pending = Array.from({ length: 32 }, () => f.create(owner));
  await vi.waitFor(async () => { expect(await f.roots()).toHaveLength(32); expect(f.child).toHaveBeenCalledOnce(); });
  let closed = false; const closing = owner.close().then(() => { closed = true; });
  expect(closed).toBe(false);
  await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  blocker.release(); await closing;
  for (const response of await Promise.all(pending)) expect(response).toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(f.child).toHaveBeenCalledTimes(32);
  expect(await f.roots()).toHaveLength(32); expect(await readdir(f.commandSocketRoot!)).toHaveLength(32);
  // Both individual scans remain below128; the distinct suffix union is32.
  const recovered = await f.controller(); expect(await f.roots()).toEqual([]);
  expect(await readdir(f.commandSocketRoot!)).toEqual([]); await recovered.close();
});

it("rechecks the failure fence after an awaited capacity/liveness probe", async () => {
  const f = await fixture(true, 1), childGate = gate(), activeGate = gate();
  f.state.childGate = childGate.promise; f.state.activeGate = activeGate.promise;
  const owner = await f.controller(), first = f.create(owner);
  await vi.waitFor(() => expect(f.child).toHaveBeenCalledOnce());
  const waiting = f.create(owner);
  await vi.waitFor(() => expect(f.execute.mock.calls.some(([, args]) => args.includes("--state=active"))).toBe(true));
  childGate.release(); await first; activeGate.release();
  await expect(waiting).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(await f.roots()).toEqual([suffix(1)]); expect(f.child).toHaveBeenCalledOnce();
});

it("keeps existing runtime controls available without reopening uncertain create admission", async () => {
  const f = await fixture(); f.state.fail = false;
  const owner = await f.controller(); await expect(f.create(owner)).resolves.toMatchObject({ ok: true });
  f.state.fail = true; await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  await expect(owner.handle({ version: 1, type: "capability.get", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1" })).resolves.toMatchObject({ ok: true });
  await expect(owner.handle({ version: 1, type: "runtime.stop", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2", runtimeHandle: handle(1) })).resolves.toMatchObject({ ok: true });
  expect(await f.roots()).toEqual([suffix(2)]);
  await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(f.child).toHaveBeenCalledTimes(2);
});

it("preserves a foreign collision and refuses recovery while its ownership is unproven", async () => {
  const f = await fixture(), owner = await f.controller(), foreign = join(f.root, "foreign");
  await mkdir(foreign); await writeFile(join(foreign, "sentinel"), "retain"); await symlink(foreign, f.commandPath(1));
  const inode = (await lstat(f.commandPath(1))).ino;
  for (let i = 0; i < 4; i++) await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(await f.roots()).toEqual([suffix(1)]); expect(f.child).toHaveBeenCalledOnce();
  await owner.close(); await expect(f.controller()).rejects.toThrow("Unsafe scope runtime directory");
  expect((await lstat(f.commandPath(1))).ino).toBe(inode);
  expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("retain");
});


it("cleans each naturally-exited runtime before reusing capacity across130 successful creates", async () => {
  const f = await fixture(true, 1); f.state.fail = false;
  const owner = await f.controller();
  for (let index = 1; index <= 130; index++) {
    await expect(f.create(owner)).resolves.toMatchObject({ ok: true, runtimeHandle: handle(index) });
    expect(await f.roots()).toEqual([suffix(index)]);
    expect(await readdir(f.commandSocketRoot!)).toEqual([suffix(index)]);
    f.exitAll();
  }
  f.state.fail = true;
  await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(await f.roots()).toEqual([suffix(131)]);
  await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
  expect(f.child).toHaveBeenCalledTimes(131);
});

it("retains exited runtime capacity when exact cleanup cannot be proven", async () => {
  const f = await fixture(true, 1); f.state.fail = false;
  const owner = await f.controller(); await expect(f.create(owner)).resolves.toMatchObject({ ok: true });
  f.exitAll(); f.state.recoveryBlocked = true;
  for (let index = 0; index < 4; index++) await expect(f.create(owner)).resolves.toMatchObject({ ok: false, error: "capacity_exceeded" });
  expect(owner.size()).toBe(1); expect(await f.roots()).toEqual([suffix(1)]);
  expect(f.child).toHaveBeenCalledOnce();
  f.state.recoveryBlocked = false;
  await expect(f.create(owner)).resolves.toMatchObject({ ok: true, runtimeHandle: handle(2) });
  expect(await f.roots()).toEqual([suffix(2)]);
});

it("coalesces prune and explicit stop, and drains their cleanup before shutdown", async () => {
  const f = await fixture(true, 1), blocker = gate(); f.state.fail = false;
  const owner = await f.controller(); await f.create(owner); f.exitAll(); f.state.observeGate = blocker.promise;
  const pending = Array.from({ length: 3 }, () => f.create(owner));
  const stopping = owner.handle({ version: 1, type: "runtime.stop", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d2", runtimeHandle: handle(1) });
  try {
    await vi.waitFor(() => expect(f.execute.mock.calls.filter(([, args]) => args[0] === "show")).toHaveLength(1));
    let closed = false; const closing = owner.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    expect(f.execute.mock.calls.filter(([, args]) => args.includes("--state=active"))).toHaveLength(1);
    blocker.release(); await closing;
    await expect(stopping).resolves.toMatchObject({ ok: true });
    for (const response of await Promise.all(pending)) expect(response).toMatchObject({ ok: false, error: "runtime_unavailable" });
    expect(f.execute.mock.calls.filter(([, args]) => args[0] === "show")).toHaveLength(1);
    expect(await f.roots()).toEqual([]); expect(f.child).toHaveBeenCalledOnce();
  } finally { blocker.release(); await Promise.allSettled([...pending, stopping]); }
});


it("waits for post-close cleanup when an admitted create succeeds after shutdown begins", async () => {
  const f = await fixture(), child = gate(), cleanupGate = gate(); f.state.fail = false;
  f.state.childGate = child.promise; f.state.observeGate = cleanupGate.promise;
  const owner = await f.controller(), creating = f.create(owner);
  try {
    await vi.waitFor(() => expect(f.child).toHaveBeenCalledOnce());
    let closed = false; const closing = owner.close().then(() => { closed = true; });
    child.release();
    await vi.waitFor(() => expect(f.execute.mock.calls.some(([, args]) => args[0] === "show")).toBe(true));
    expect(closed).toBe(false);
    cleanupGate.release(); await closing;
    await expect(creating).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
    expect(await f.roots()).toEqual([]);
  } finally { child.release(); cleanupGate.release(); await creating; }
});

it.each([NaN, Infinity, -Infinity])("rejects non-finite runtime capacity %s", async capacity => {
  const f = await fixture(true, capacity);
  await expect(f.controller()).rejects.toThrow("Invalid scope runtime capacity");
  expect(f.child).not.toHaveBeenCalled();
});
