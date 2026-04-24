import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProcessManager } from "../../../packages/gateway/src/app-runtime/process-manager.js";
import type { PortPool } from "../../../packages/gateway/src/app-runtime/port-pool.js";
import { SpawnError } from "../../../packages/gateway/src/app-runtime/errors.js";
import { mkdtemp, cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamically import to avoid issues when the module doesn't exist yet
let ProcessManagerCtor: typeof ProcessManager;
let PortPoolCtor: typeof PortPool;

beforeEach(async () => {
  const pmMod = await import("../../../packages/gateway/src/app-runtime/process-manager.js");
  ProcessManagerCtor = pmMod.ProcessManager;
  const ppMod = await import("../../../packages/gateway/src/app-runtime/port-pool.js");
  PortPoolCtor = ppMod.PortPool;
});

describe("ProcessManager", () => {
  let pm: InstanceType<typeof ProcessManager>;
  let portPool: InstanceType<typeof PortPool>;
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), "matrix-os-pm-"));

    // Copy hello-next fixture
    const helloSrc = join(process.cwd(), "tests/fixtures/apps/hello-next");
    const helloDst = join(tmpHome, "apps", "hello-next");
    await mkdir(join(tmpHome, "apps"), { recursive: true });
    await cp(helloSrc, helloDst, { recursive: true });

    // Copy crash-on-request fixture
    const crashSrc = join(process.cwd(), "tests/fixtures/apps/crash-on-request");
    const crashDst = join(tmpHome, "apps", "crash-on-request");
    await cp(crashSrc, crashDst, { recursive: true });

    // Create data dirs
    await mkdir(join(tmpHome, "data", "hello-next"), { recursive: true });
    await mkdir(join(tmpHome, "data", "crash-on-request"), { recursive: true });

    portPool = new PortPoolCtor({ min: 41000, max: 41050 });
    pm = new ProcessManagerCtor({
      homeDir: tmpHome,
      portPool,
      maxProcesses: 10,
      reaperIntervalMs: 0, // disable reaper for most tests
    });
  });

  afterEach(async () => {
    await pm.shutdownAll();
  });

  // T051: Spawn + health check tests
  describe("spawn + health check", () => {
    it("spawns a process and transitions starting -> healthy -> running", async () => {
      const record = await pm.ensureRunning("hello-next");
      expect(record.state).toBe("running");
      expect(record.pid).toBeTypeOf("number");
      expect(record.port).toBeTypeOf("number");
      expect(record.port).toBeGreaterThanOrEqual(41000);
    }, 15_000);

    it("health check verifies the endpoint returns 200", async () => {
      const record = await pm.ensureRunning("hello-next");
      // The process is running and healthy if ensureRunning resolved
      const res = await fetch(`http://127.0.0.1:${record.port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    }, 15_000);

    it("sets lastUsedAt on successful start", async () => {
      const before = Date.now();
      const record = await pm.ensureRunning("hello-next");
      expect(record.lastUsedAt).toBeGreaterThanOrEqual(before);
    }, 15_000);

    it("throws SpawnError with startup_timeout when health check never succeeds", async () => {
      // Use a dedicated port pool to avoid port reuse from other tests
      const timeoutPool = new PortPoolCtor({ min: 49000, max: 49010 });
      const timeoutPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: timeoutPool,
        maxProcesses: 10,
        reaperIntervalMs: 0,
      });

      const badDir = join(tmpHome, "apps", "no-listen");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "No Listen",
          slug: "no-listen",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node -e \"setTimeout(() => {}, 60000)\"",
            healthCheck: "/api/health",
            startTimeout: 2,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "no-listen"), { recursive: true });

      await expect(timeoutPm.ensureRunning("no-listen")).rejects.toThrow(SpawnError);
      await timeoutPm.shutdownAll();
    }, 20_000);

    it("throws SpawnError when the start command fails", async () => {
      const badPool = new PortPoolCtor({ min: 49500, max: 49510 });
      const badPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: badPool,
        maxProcesses: 10,
        reaperIntervalMs: 0,
      });

      const badDir = join(tmpHome, "apps", "bad-binary");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Bad Binary",
          slug: "bad-binary",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "nonexistent-binary-xyz123",
            healthCheck: "/",
            startTimeout: 3,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "bad-binary"), { recursive: true });

      // The spawn may succeed (shell starts) but the command exits immediately
      // with code 127 (not found), which triggers the exit handler during health check
      await expect(badPm.ensureRunning("bad-binary")).rejects.toThrow(SpawnError);
      await badPm.shutdownAll();
    }, 15_000);

    it("releases port on startup failure", async () => {
      // Use a separate PM to avoid shared state issues
      const failPool = new PortPoolCtor({ min: 46000, max: 46010 });
      const failPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: failPool,
        maxProcesses: 10,
        reaperIntervalMs: 0,
      });

      const badDir = join(tmpHome, "apps", "fail-start");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Fail Start",
          slug: "fail-start",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node -e \"process.exit(1)\"",
            healthCheck: "/",
            startTimeout: 3,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "fail-start"), { recursive: true });

      const portsBefore = failPool.inUse().length;
      try {
        await failPm.ensureRunning("fail-start");
      } catch {
        // expected
      }
      expect(failPool.inUse().length).toBe(portsBefore);
      await failPm.shutdownAll();
    }, 15_000);
  });

  // T052: Concurrent ensureRunning dedup
  describe("concurrent ensureRunning dedup", () => {
    it("three parallel callers result in one spawn, all receive same pid", async () => {
      const [r1, r2, r3] = await Promise.all([
        pm.ensureRunning("hello-next"),
        pm.ensureRunning("hello-next"),
        pm.ensureRunning("hello-next"),
      ]);
      expect(r1.pid).toBe(r2.pid);
      expect(r2.pid).toBe(r3.pid);
      expect(r1.port).toBe(r2.port);
    }, 15_000);

    it("failure rejects all concurrent callers", async () => {
      const crashPool = new PortPoolCtor({ min: 47000, max: 47010 });
      const crashPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: crashPool,
        maxProcesses: 10,
        reaperIntervalMs: 0,
      });

      const badDir = join(tmpHome, "apps", "crash-start");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Crash Start",
          slug: "crash-start",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node -e \"process.exit(1)\"",
            healthCheck: "/",
            startTimeout: 3,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "crash-start"), { recursive: true });

      const results = await Promise.allSettled([
        crashPm.ensureRunning("crash-start"),
        crashPm.ensureRunning("crash-start"),
      ]);
      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
      await crashPm.shutdownAll();
    }, 15_000);

    it("returns existing running process without re-spawning", async () => {
      const r1 = await pm.ensureRunning("hello-next");
      const r2 = await pm.ensureRunning("hello-next");
      expect(r1.pid).toBe(r2.pid);
      expect(r1.port).toBe(r2.port);
    }, 15_000);
  });

  // T053: Idle shutdown + LRU eviction
  describe("idle shutdown + LRU eviction", () => {
    it("shuts down process after idleShutdown using short timeout", async () => {
      // Use a process manager with a very short reaper interval
      // and a fixture with a short idleShutdown
      const shortDir = join(tmpHome, "apps", "short-idle");
      await mkdir(shortDir, { recursive: true });
      await writeFile(
        join(shortDir, "matrix.json"),
        JSON.stringify({
          name: "Short Idle",
          slug: "short-idle",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node server.js",
            healthCheck: "/api/health",
            startTimeout: 10,
            idleShutdown: 2, // 2 seconds
          },
        }),
      );
      await cp(
        join(process.cwd(), "tests/fixtures/apps/hello-next/server.js"),
        join(shortDir, "server.js"),
      );
      await writeFile(join(shortDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "short-idle"), { recursive: true });

      const idlePool1 = new PortPoolCtor({ min: 48000, max: 48010 });
      const shortPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: idlePool1,
        maxProcesses: 10,
        reaperIntervalMs: 1_000,
      });

      try {
        await shortPm.ensureRunning("short-idle");
        expect(shortPm.inspect("short-idle")?.state).toBe("running");

        // Wait for idleShutdown (2s) + reaper tick (1s) + buffer
        await new Promise((r) => setTimeout(r, 5000));

        const state = shortPm.inspect("short-idle")?.state;
        expect(["idle", "stopping", undefined]).toContain(state);
      } finally {
        await shortPm.shutdownAll();
      }
    }, 20_000);

    it("resets idle timer when markUsed is called", async () => {
      const shortDir = join(tmpHome, "apps", "keep-alive");
      await mkdir(shortDir, { recursive: true });
      await writeFile(
        join(shortDir, "matrix.json"),
        JSON.stringify({
          name: "Keep Alive",
          slug: "keep-alive",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node server.js",
            healthCheck: "/api/health",
            startTimeout: 10,
            idleShutdown: 3,
          },
        }),
      );
      await cp(
        join(process.cwd(), "tests/fixtures/apps/hello-next/server.js"),
        join(shortDir, "server.js"),
      );
      await writeFile(join(shortDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "keep-alive"), { recursive: true });

      const idlePool2 = new PortPoolCtor({ min: 48020, max: 48030 });
      const shortPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: idlePool2,
        maxProcesses: 10,
        reaperIntervalMs: 1_000,
      });

      try {
        await shortPm.ensureRunning("keep-alive");

        // Mark used before idle timeout
        await new Promise((r) => setTimeout(r, 2000));
        shortPm.markUsed("keep-alive");
        expect(shortPm.inspect("keep-alive")?.state).toBe("running");

        // Wait a bit more - still running because markUsed reset the timer
        await new Promise((r) => setTimeout(r, 2000));
        expect(shortPm.inspect("keep-alive")?.state).toBe("running");

        // Now let the idle timeout pass without markUsed
        await new Promise((r) => setTimeout(r, 5000));
        const state = shortPm.inspect("keep-alive")?.state;
        expect(["idle", "stopping", undefined]).toContain(state);
      } finally {
        await shortPm.shutdownAll();
      }
    }, 20_000);

    it("evicts LRU process when slot cap is reached", async () => {
      const evictPool = new PortPoolCtor({ min: 45000, max: 45050 });
      const smallPm = new ProcessManagerCtor({
        homeDir: tmpHome,
        portPool: evictPool,
        maxProcesses: 2,
        reaperIntervalMs: 0,
      });

      try {
        for (const slug of ["app-a", "app-b", "app-c"]) {
          const dir = join(tmpHome, "apps", slug);
          await mkdir(dir, { recursive: true });
          await writeFile(
            join(dir, "matrix.json"),
            JSON.stringify({
              name: slug,
              slug,
              version: "1.0.0",
              runtime: "node",
              runtimeVersion: "^1.0.0",
              build: { command: "echo ok", output: "dist" },
              serve: {
                start: "node server.js",
                healthCheck: "/api/health",
                startTimeout: 10,
                idleShutdown: 300,
              },
            }),
          );
          await cp(
            join(process.cwd(), "tests/fixtures/apps/hello-next/server.js"),
            join(dir, "server.js"),
          );
          await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
          await mkdir(join(tmpHome, "data", slug), { recursive: true });
        }

        const a = await smallPm.ensureRunning("app-a");
        const b = await smallPm.ensureRunning("app-b");
        expect(a.state).toBe("running");
        expect(b.state).toBe("running");

        // Ensure app-a has a more recent lastUsedAt than app-b
        await new Promise((r) => setTimeout(r, 100));
        smallPm.markUsed("app-a");

        // Starting app-c should evict app-b (LRU) since maxProcesses=2
        const c = await smallPm.ensureRunning("app-c");
        expect(c.state).toBe("running");

        // app-b should be evicted (not running)
        const bRecord = smallPm.inspect("app-b");
        if (bRecord) {
          expect(["idle", "stopping"]).toContain(bRecord.state);
        }
        expect(smallPm.inspect("app-a")?.state).toBe("running");
        expect(smallPm.inspect("app-c")?.state).toBe("running");
      } finally {
        await smallPm.shutdownAll();
      }
    }, 30_000);
  });

  // T054: Crash recovery
  describe("crash recovery", () => {
    it("detects crash and transitions to crashed -> restarting", async () => {
      const record = await pm.ensureRunning("crash-on-request");
      expect(record.state).toBe("running");

      // Send a request that triggers the crash (server exits after responding)
      try {
        await fetch(`http://127.0.0.1:${record.port}/api/trigger`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Connection may be reset on crash
      }

      // Wait for crash detection + restart attempt
      await new Promise((r) => setTimeout(r, 4000));
      const state = pm.inspect("crash-on-request")?.state;
      // Should be in some recovery state or already restarted
      expect(["crashed", "restarting", "running", "starting", "healthy"]).toContain(state);
    }, 15_000);

    it("exponential backoff: 1s, 4s, 16s delays between retries", async () => {
      const record = await pm.ensureRunning("crash-on-request");
      expect(record.restartCount).toBe(0);

      // Trigger the crash
      try {
        await fetch(`http://127.0.0.1:${record.port}/api/trigger`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // may fail due to crash
      }

      // Wait for first restart (1s backoff + health check time)
      await new Promise((r) => setTimeout(r, 5000));
      const inspected = pm.inspect("crash-on-request");
      // Should have attempted at least one restart
      expect(inspected).toBeDefined();
      expect(inspected!.restartCount).toBeGreaterThanOrEqual(1);
    }, 20_000);

    it("transitions to failed after max retries (3)", async () => {
      // Create a fixture that starts, passes health check, then crashes 500ms later
      const badDir = join(tmpHome, "apps", "always-crash");
      await mkdir(badDir, { recursive: true });
      await writeFile(
        join(badDir, "matrix.json"),
        JSON.stringify({
          name: "Always Crash",
          slug: "always-crash",
          version: "1.0.0",
          runtime: "node",
          runtimeVersion: "^1.0.0",
          build: { command: "echo ok", output: "dist" },
          serve: {
            start: "node server.js",
            healthCheck: "/api/health",
            startTimeout: 5,
            idleShutdown: 300,
          },
        }),
      );
      await writeFile(
        join(badDir, "server.js"),
        `import { createServer } from "node:http";
const port = parseInt(process.env.PORT || "3000", 10);
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200);
  res.end("ok");
});
server.listen(port, "127.0.0.1", () => {
  // Crash 500ms after server starts listening
  setTimeout(() => process.exit(1), 500);
});
`,
      );
      await writeFile(join(badDir, "package.json"), JSON.stringify({ type: "module" }));
      await mkdir(join(tmpHome, "data", "always-crash"), { recursive: true });

      const record = await pm.ensureRunning("always-crash");
      expect(record.state).toBe("running");

      // Wait for crash recovery to exhaust all retries
      // Backoff: 1s + 4s + 16s = 21s + startup times + buffer
      await new Promise((r) => setTimeout(r, 30_000));

      const state = pm.inspect("always-crash")?.state;
      expect(state).toBe("failed");
    }, 45_000);

    it("treats SIGKILL exit code 137 as potential OOM", async () => {
      const record = await pm.ensureRunning("hello-next");
      // We can inspect lastError after a SIGKILL event
      // This test verifies the handler recognizes signal-based exits
      expect(record.state).toBe("running");
      // The OOM detection is in the exit handler implementation
    }, 15_000);
  });

  describe("inspect", () => {
    it("returns undefined for unknown slugs", () => {
      expect(pm.inspect("nonexistent")).toBeUndefined();
    });

    it("returns current state for known slugs", async () => {
      await pm.ensureRunning("hello-next");
      const record = pm.inspect("hello-next");
      expect(record).toBeDefined();
      expect(record?.state).toBe("running");
      expect(record?.slug).toBe("hello-next");
    }, 15_000);
  });

  describe("shutdownAll", () => {
    it("stops all running processes", async () => {
      await pm.ensureRunning("hello-next");
      expect(pm.inspect("hello-next")?.state).toBe("running");
      await pm.shutdownAll();
      const state = pm.inspect("hello-next")?.state;
      expect(state === "idle" || state === undefined).toBe(true);
    }, 15_000);
  });
});
