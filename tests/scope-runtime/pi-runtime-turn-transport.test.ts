import { mkdir, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createScopeRuntimeClient } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import { BOT_SCOPE_RUNTIME_PROFILE_CATALOG } from "../../packages/gateway/src/bots/scope-runtime-profile.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { createScopeRuntimeController, SCOPE_RUNTIME_BOT_PROFILE, type ScopeRuntimeLauncher } from "../../packages/scope-runtime/src/supervisor.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { startBotCommandServer } from "../../packages/scope-runtime/src/worker-bot.js";

const handle = `runtime_${"2".repeat(32)}`;
const scopeHandle = `scope_${"1".repeat(32)}`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await createUnixSocketTempDir();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const commandDirectory = join(root, "runtimes", "2".repeat(32), "command");
  await mkdir(commandDirectory, { recursive: true });
  let resolveWorker!: (reply: Record<string, unknown>) => void;
  let entered!: () => void;
  const enteredRun = new Promise<void>(resolve => { entered = resolve; });
  const workerResult = new Promise<Record<string, unknown>>(resolve => { resolveWorker = resolve; });
  const worker = await startBotCommandServer({ socketPath: join(commandDirectory, "worker.sock"),
    invocation: { runtimeHandle: handle, scopeHandle, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0", executionGeneration: "4" },
    handler: { async handle(command) { if (command.kind === "bot.run") { entered(); return workerResult; } resolveWorker({ status: "cancelled" }); return { acknowledged: true }; } } });
  cleanups.push(() => worker.close());
  const native = createSystemdScopeRuntimeLauncher({ stateRoot: root, sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "unused"), brokerSocket: join(root, "broker.sock"), runCommand: vi.fn(async () => ({ stdout: "" })) });
  const stop = vi.fn(async () => { resolveWorker({ status: "cancelled" }); });
  const launcher: ScopeRuntimeLauncher = { list: async () => [], supportedAdapters: async () => SCOPE_RUNTIME_BOT_PROFILE.adapters,
    start: async () => undefined, runChat: async () => ({ text: "unused" }), runBot: native.runBot, stop };
  const controller = await createScopeRuntimeController({ launcher, executionGeneration: "4", createRuntimeHandle: () => handle });
  const server = createScopeRuntimeServer({ socketPath: join(root, "supervisor.sock"), controller });
  await server.start();
  cleanups.push(() => server.close());
  const client = createScopeRuntimeClient({ socketPath: join(root, "supervisor.sock"), profileCatalog: BOT_SCOPE_RUNTIME_PROFILE_CATALOG });
  cleanups.push(() => client.close());
  await client.refreshCapability();
  const identity = await client.createRuntime({ scopeHandle, profileId: SCOPE_RUNTIME_BOT_PROFILE.profileId, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0",
    sandbox: { version: 1, scopeHandle, actorId: "owner", worktree: { hostPath: "/owned/project", mode: "rw", fingerprint: "a".repeat(64) }, network: "broker_only" } });
  const workerConnections = () => new Promise<number>((resolve, reject) => worker.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  return { client, identity, enteredRun, resolveWorker, stop, workerConnections, closeServer: () => server.close() };
}

describe("Pi busy-turn transport through real Unix sockets", () => {
  it("keeps every relay alive beyond 31 minutes while the same gateway renews its runtime", async () => {
    // Make old AbortSignal.timeout wall timers observable to the virtual clock too.
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; });
    const timeouts = vi.spyOn(Socket.prototype, "setTimeout");
    const test = await fixture();
    let ended = false;
    const pending = test.client.runBot({ ...test.identity, command: { version: 1, kind: "bot.run", runId: "run_long" } }).then(value => { ended = true; return value; }, error => { ended = true; return error; });
    await test.enteredRun;
    for (let part = 0; part < 3; part++) { await vi.advanceTimersByTimeAsync(14 * 60_000); await test.client.renewRuntime(test.identity); }
    expect(ended).toBe(false);
    expect(test.stop).not.toHaveBeenCalled();
    // Native socket timeouts are not virtual timers: explicitly check no hidden run timer remains.
    expect(timeouts.mock.calls.map(call => call[0]).filter(ms => ms > 90_000)).toEqual([]);
    test.resolveWorker({ status: "completed", runId: "run_long" });
    await expect(pending).resolves.toMatchObject({ ok: true, reply: { status: "completed" } });
  });
  it("stops and settles the pending worker when its gateway stops renewing", async () => {
    vi.useFakeTimers();
    const test = await fixture();
    const pending = test.client.runBot({ ...test.identity, command: { version: 1, kind: "bot.run", runId: "run_lost" } });
    await test.enteredRun;
    await vi.advanceTimersByTimeAsync(900_000);
    expect(test.stop).toHaveBeenCalledExactlyOnceWith(handle);
    await expect(pending).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
    await expect(test.client.renewRuntime(test.identity)).rejects.toMatchObject({ code: "runtime_unavailable" });
  });
  it("lets the caller abort its long relay without waiting for a lease or wall deadline", async () => {
    vi.useFakeTimers();
    const test = await fixture();
    const caller = new AbortController();
    let error: unknown;
    const pending = test.client.runBot({ ...test.identity, signal: caller.signal, command: { version: 1, kind: "bot.run", runId: "run_stop" } }).catch(reason => { error = reason; });
    await test.enteredRun;
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toMatchObject({ code: "runtime_unavailable" });
    await pending;
    test.resolveWorker({ status: "cancelled" });
  });
  it("releases all relay connections after caller disconnect even while the worker handler remains pending", async () => {
    const test = await fixture();
    const caller = new AbortController();
    const pending = test.client.runBot({ ...test.identity, signal: caller.signal, command: { version: 1, kind: "bot.run", runId: "run_disconnect" } }).catch(error => error);
    await test.enteredRun;
    expect(await test.workerConnections()).toBe(1);
    caller.abort();
    await expect(pending).resolves.toMatchObject({ code: "runtime_unavailable" });
    await vi.waitFor(async () => expect(await test.workerConnections()).toBe(0), { timeout: 500 });
    test.resolveWorker({ status: "cancelled" });
  });
  it("settles the long relay when Stop revokes its runtime", async () => {
    const test = await fixture();
    const pending = test.client.runBot({ ...test.identity, command: { version: 1, kind: "bot.run", runId: "run_stop" } });
    await test.enteredRun;
    await expect(test.client.stopRuntime(test.identity)).resolves.toMatchObject({ state: "stopped" });
    await expect(pending).resolves.toMatchObject({ ok: false, error: "runtime_unavailable" });
    await vi.waitFor(async () => expect(await test.workerConnections()).toBe(0));
  });
  it("drains an outstanding relay on supervisor close without waiting for a run deadline", async () => {
    const test = await fixture();
    const pending = test.client.runBot({ ...test.identity, command: { version: 1, kind: "bot.run", runId: "run_shutdown" } }).catch(error => error);
    await test.enteredRun;
    await test.closeServer();
    await expect(pending).resolves.toMatchObject({ code: "runtime_unavailable" });
    await vi.waitFor(async () => expect(await test.workerConnections()).toBe(0));
  });
});
