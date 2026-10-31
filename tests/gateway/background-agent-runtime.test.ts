import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, symlink, lstat, utimes, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackgroundAgentRuntime } from "../../packages/gateway/src/background-agent-runtime.js";

const homes: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];
const withLock = async <T>(_path: string, action: () => Promise<T>) => action();
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function harness(options: { delayHandshake?: boolean } = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-background-"));
  homes.push(homePath);
  const units = new Map<string, string>();
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    if (command.endsWith("systemd-run")) units.set(args.find(a => a.startsWith("--unit="))!.slice(7), "active");
    if (args.includes("stop")) units.set(args.at(-1)!, "inactive");
    if (args.includes("show")) return { stdout: args.filter(arg => arg.endsWith(".service")).map(name => `Id=${name}\nLoadState=loaded\nActiveState=${units.get(name) ?? "inactive"}\nSubState=running\n`).join("\n"), stderr: "" };
    return { stdout: "", stderr: "" };
  });
  let spawned!: () => void, releaseHandshake!: () => void;
  const spawnedPromise = new Promise<void>(resolve => { spawned = resolve; });
  let heldChild: { stdin: PassThrough; stdout: PassThrough } | undefined;
  // Named systemd transport fixture: validates actual runtime selection/handshake, not Linux FD passing.
  const spawnPrivate = vi.fn((_command: string, args: string[]) => {
    units.set(args.find(a => a.startsWith("--unit="))!.slice(7), "active");
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
    heldChild = child; releaseHandshake = () => { child.stdout.write(JSON.stringify({ type: "wrapper.ready", wrapper: "00000000-0000-4000-8000-000000000001", shim: "00000000-0000-4000-8000-000000000002", digest: args.at(-1) }) + "\n"); };
    if (!options.delayHandshake) queueMicrotask(releaseHandshake);
    spawned();
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const runtime = createBackgroundAgentRuntime({ homePath, runCommand, maxJobs: 2, withLock, spawnPrivate });
  runtimes.push(runtime);
  const launch = { command: "/usr/bin/node", args: ["runner.mjs"], env: { PRIVATE_TEST: "secret-value" }, cwd: homePath };
  return { homePath, units, runCommand, spawnPrivate, runtime, launch, spawned: spawnedPromise, releaseHandshake: () => releaseHandshake(), heldChild: () => heldChild! };
}

describe("background agent runtime", () => {
  it("supervises a private launch independently of terminal tabs", async () => {
    const h = await harness();
    const ref = await h.runtime.start({ sessionId: "sess_test", launch: h.launch });
    expect(await h.runtime.isRunning(ref)).toBe(true);
    const args = h.runCommand.mock.calls.find(([command]) => command.endsWith("systemd-run"))![1];
    expect(args).toEqual(expect.arrayContaining(["--user", "--property=KillMode=control-group", "--property=TasksMax=1024"]));
    expect(args.join(" ")).not.toMatch(/zellij|secret-value/);
    expect(ref).not.toHaveProperty("terminalRef");
    await h.runtime.stop(ref);
    expect(await h.runtime.isRunning(ref)).toBe(false);
  });

  it("selects a retained anonymous-pipe launch only for an explicit private host callback", async () => {
    const h = await harness(), onReady = vi.fn();
    const launch = { ...h.launch, command: process.execPath, args: [resolve("packages/gateway/src/coding-agents/codex-app-server-runner.mjs")] };
    const ref = await h.runtime.start({ sessionId: "sess_private", launch, privateControl: { onReady } });
    expect(h.spawnPrivate).toHaveBeenCalledTimes(1);
    expect(h.spawnPrivate.mock.calls[0][1]).toContain("--pipe");
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][0].generation).toBe("00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002");
    const descriptor = await readFile(join(h.homePath, "system", "background-agents", ref.id, "launch.json"), "utf8");
    expect(JSON.parse(descriptor)).toEqual({ sessionId: "sess_private", launch });
    expect(descriptor).not.toMatch(/onReady|generation|admissionId|RoutineCapability/);
    await h.runtime.close();
    expect(onReady.mock.calls[0][0].send({ type: "host.disconnect" })).toBe(false);
    expect(await h.runtime.isRunning(ref).catch(() => null)).toBeNull();
    expect(h.units.values().next().value).toBe("active"); // Closing proof does not stop the service.
  });

  it("shutdown fences a private handshake that completes after close began without stopping the owned service", async () => {
    const h = await harness({ delayHandshake: true }), onReady = vi.fn();
    const launch = { ...h.launch, command: process.execPath, args: [resolve("packages/gateway/src/coding-agents/codex-app-server-runner.mjs")] };
    const starting = h.runtime.start({ sessionId: "sess_late_handshake", launch, privateControl: { onReady } });
    await h.spawned;
    const closing = h.runtime.close(); h.releaseHandshake();
    await starting; await closing;
    try {
      expect(onReady).not.toHaveBeenCalled();
      expect(h.heldChild().stdin.writableEnded).toBe(true);
      expect(h.units.values().next().value).toBe("active");
      expect(h.runCommand.mock.calls.some(([, args]) => args.includes("stop"))).toBe(false);
    } finally { for (const [channel] of onReady.mock.calls) channel.close(); }
  });

  it("does not grant arbitrary launch specifications a private pipe", async () => {
    const h = await harness(), onReady = vi.fn();
    await h.runtime.start({ sessionId: "sess_arbitrary", launch: h.launch, privateControl: { onReady } });
    expect(onReady).not.toHaveBeenCalled(); expect(h.spawnPrivate).not.toHaveBeenCalled();
  });

  it("retains jobs across supervisor recreation and bounds admission", async () => {
    const h = await harness();
    const a = await h.runtime.start({ sessionId: "sess_a", launch: h.launch });
    const b = await h.runtime.start({ sessionId: "sess_b", launch: h.launch });
    const restarted = createBackgroundAgentRuntime({ homePath: h.homePath, runCommand: h.runCommand, maxJobs: 2, withLock });
    runtimes.push(restarted);
    expect(await restarted.isRunning(a)).toBe(true);
    await expect(restarted.start({ sessionId: "sess_c", launch: h.launch })).rejects.toThrow(/capacity/i);
    await restarted.stop(a);
    expect(await restarted.isRunning(b)).toBe(true);
    await expect(restarted.start({ sessionId: "sess_c", launch: h.launch })).resolves.toBeDefined();
  });

  it("reads admission inventory in one bounded systemd request", async () => {
    const h = await harness();
    await h.runtime.start({ sessionId: "sess_a", launch: h.launch });
    await h.runtime.start({ sessionId: "sess_b", launch: h.launch });
    h.runCommand.mockClear();
    await expect(h.runtime.start({ sessionId: "sess_c", launch: h.launch })).rejects.toThrow(/capacity/i);
    expect(h.runCommand.mock.calls.filter(([, args]) => args.includes("show"))).toHaveLength(1);
  });

  it("does not report stop success while the exact service remains active", async () => {
    const h = await harness();
    const ref = await h.runtime.start({ sessionId: "sess_a", launch: h.launch });
    h.runCommand.mockImplementation(async (_command, args) => ({ stdout: `Id=${args.at(-1)}\nLoadState=loaded\nActiveState=active\nSubState=running\n`, stderr: "" }));
    await expect(h.runtime.stop(ref)).rejects.toThrow(/stop/i);
    expect(await h.runtime.isRunning(ref)).toBe(true);
  });

  it("rejects a symlinked system directory before creating storage outside the owner home", async () => {
    const h = await harness();
    const outside = await mkdtemp(join(tmpdir(), "matrix-background-outside-"));
    homes.push(outside);
    await symlink(outside, join(h.homePath, "system"));
    await expect(h.runtime.start({ sessionId: "sess_a", launch: h.launch })).rejects.toThrow(/storage/i);
    await expect(lstat(join(outside, "background-agents"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  it("cleans stopped retained jobs after recreation without needing a new start", async () => {
    const h = await harness();
    const ref = await h.runtime.start({ sessionId: "sess_old", launch: h.launch });
    await h.runtime.stop(ref);
    await h.runtime.close();
    const dir = join(h.homePath, "system", "background-agents", ref.id);
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    await utimes(dir, old, old);
    vi.useFakeTimers();
    const restarted = createBackgroundAgentRuntime({ homePath: h.homePath, runCommand: h.runCommand, withLock });
    runtimes.push(restarted);
    try {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await restarted.close();
      await expect(lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.useRealTimers(); }
  });

  it("rejects forged references before issuing system commands", async () => {
    const h = await harness();
    await expect(h.runtime.stop({ id: "../../other.service" })).rejects.toThrow();
    expect(h.runCommand).not.toHaveBeenCalled();
  });
});
