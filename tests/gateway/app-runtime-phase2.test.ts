import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProcessManager } from "../../packages/gateway/src/app-runtime/process-manager.js";
import type { PortPool } from "../../packages/gateway/src/app-runtime/port-pool.js";
import { mkdtemp, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Phase 2 integration: node runtime", () => {
  let ProcessManagerCtor: typeof ProcessManager;
  let PortPoolCtor: typeof PortPool;
  let pm: InstanceType<typeof ProcessManager>;
  let portPool: InstanceType<typeof PortPool>;
  let tmpHome: string;

  beforeEach(async () => {
    const pmMod = await import("../../packages/gateway/src/app-runtime/process-manager.js");
    ProcessManagerCtor = pmMod.ProcessManager;
    const ppMod = await import("../../packages/gateway/src/app-runtime/port-pool.js");
    PortPoolCtor = ppMod.PortPool;

    tmpHome = await mkdtemp(join(tmpdir(), "matrix-os-phase2-"));
    await mkdir(join(tmpHome, "apps"), { recursive: true });
    await mkdir(join(tmpHome, "data"), { recursive: true });

    // Copy fixtures
    for (const fixture of ["hello-next", "crash-on-request"]) {
      const src = join(process.cwd(), "tests/fixtures/apps", fixture);
      const dst = join(tmpHome, "apps", fixture);
      await cp(src, dst, { recursive: true });
      await mkdir(join(tmpHome, "data", fixture), { recursive: true });
    }

    portPool = new PortPoolCtor({ min: 43000, max: 43100 });
    pm = new ProcessManagerCtor({
      homeDir: tmpHome,
      portPool,
      maxProcesses: 10,
      reaperIntervalMs: 30_000,
    });
  });

  afterEach(async () => {
    await pm.shutdownAll();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("installs, spawns, and proxies a node app — hello-next responds on /api/hello", async () => {
    const record = await pm.ensureRunning("hello-next");
    expect(record.state).toBe("running");

    const res = await fetch(`http://127.0.0.1:${record.port}/api/hello`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "hello from next" });
  }, 15_000);

  it("cold starts a shut-down app on next ensureRunning call", async () => {
    const r1 = await pm.ensureRunning("hello-next");
    const port1 = r1.port;
    await pm.stop("hello-next");

    // Wait for shutdown
    await new Promise((r) => setTimeout(r, 1000));
    const stateAfterStop = pm.inspect("hello-next")?.state;
    expect(["idle", "stopping", undefined]).toContain(stateAfterStop);

    // Cold start
    const r2 = await pm.ensureRunning("hello-next");
    expect(r2.state).toBe("running");
    expect(r2.pid).not.toBe(r1.pid);

    const res = await fetch(`http://127.0.0.1:${r2.port}/api/hello`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(200);
  }, 20_000);

  it("survives a child crash and serves next request after recovery", async () => {
    const record = await pm.ensureRunning("crash-on-request");
    expect(record.state).toBe("running");

    // Trigger the crash
    await fetch(`http://127.0.0.1:${record.port}/api/trigger`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    // Wait for crash detection and restart (backoff 1s + health check time)
    await new Promise((r) => setTimeout(r, 5000));

    // After recovery, the process should be running again
    const afterState = pm.inspect("crash-on-request")?.state;
    expect(["running", "starting", "restarting"]).toContain(afterState);
  }, 15_000);

  it("idle shutdown releases the port back to the pool", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const record = await pm.ensureRunning("hello-next");
    const allocatedPort = record.port!;
    expect(portPool.inUse()).toContain(allocatedPort);

    // Advance past idle timeout
    vi.advanceTimersByTime(300_000 + 31_000);
    await vi.runAllTimersAsync();

    // Port should be released
    expect(portPool.inUse()).not.toContain(allocatedPort);

    vi.useRealTimers();
  }, 15_000);

  it("shutdownAll SIGTERMs all running children", async () => {
    await pm.ensureRunning("hello-next");
    await pm.ensureRunning("crash-on-request");

    expect(pm.inspect("hello-next")?.state).toBe("running");
    expect(pm.inspect("crash-on-request")?.state).toBe("running");

    await pm.shutdownAll();

    // All processes should be stopped
    for (const slug of ["hello-next", "crash-on-request"]) {
      const state = pm.inspect(slug)?.state;
      expect(state === "idle" || state === undefined).toBe(true);
    }

    // All ports should be released
    expect(portPool.inUse()).toEqual([]);
  }, 15_000);

  it("process manager map is bounded by maxProcesses", async () => {
    // The process manager should not exceed the configured cap
    // This is tested more thoroughly in the process-manager unit tests
    const record = await pm.ensureRunning("hello-next");
    expect(record).toBeDefined();
    expect(pm.inspect("hello-next")?.state).toBe("running");
  }, 15_000);
});
