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
async function fixture() {
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
  const spawnPrivate = vi.fn((_command: string, args: string[]) => {
    const unit = args.find(arg => arg.startsWith("--unit="))!.slice(7); units.set(unit, true);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
    const digest = args.at(-1), wrapper = randomUUID(), shim = randomUUID(); let bytes = "";
    child.stdin.on("data", data => { bytes += data.toString(); let at; while ((at = bytes.indexOf("\n")) >= 0) {
      const frame = JSON.parse(bytes.slice(0, at)); bytes = bytes.slice(at + 1);
      if (frame.type === "host.terminal.admit") child.stdout.write(JSON.stringify({ type: "terminal.bound", admissionId: frame.admissionId, supervisor, host, root: nativeRoot, invocationId: "c".repeat(32), generation: closure.generation }) + "\n");
    } });
    queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "wrapper.ready", wrapper, shim, digest }) + "\n"));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const options = { homePath: home, namespaceRoot, runtimeRoot, generation: closure.generation,
    generationLockHelperPath: resolve("distro/customer-vps/host-bin/matrix-terminal-generation-gc.py"), runCommand: run, spawnPrivate,
    readProcess: async (pid: number) => [supervisor, host, nativeRoot].find(value => value.pid === pid)! };
  const service = createTerminalHostService(options); cleanup.push(service.close);
  const launch = { command: "/bin/sh", args: [], cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home }, inheritEnv: false as const };
  return { service, options, home, units, run, spawnPrivate, launch, confirmedStop: () => { stopUncertain = false; } };
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
