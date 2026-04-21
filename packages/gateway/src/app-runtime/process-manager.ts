import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { SpawnError, type SpawnErrorCode } from "./errors.js";
import { safeEnv } from "./safe-env.js";
import { loadManifest } from "./manifest-loader.js";
import type { AppManifest } from "./manifest-schema.js";
import type { PortPool } from "./port-pool.js";

export type ProcessState =
  | "idle"
  | "starting"
  | "healthy"
  | "running"
  | "stopping"
  | "crashed"
  | "restarting"
  | "startup_failed"
  | "failed";

export interface ProcessRecord {
  slug: string;
  state: ProcessState;
  pid: number | null;
  port: number | null;
  startedAt: number;
  lastUsedAt: number;
  restartCount: number;
  lastError?: { code: string; stderrTail: string };
  child: ChildProcess | null;
  startupPromise: Promise<ProcessRecord> | null;
}

export interface ProcessManagerOptions {
  homeDir: string;
  portPool: PortPool;
  maxProcesses?: number;
  reaperIntervalMs?: number;
}

const MAX_RESTART_ATTEMPTS = 3;
const BACKOFF_SCHEDULE = [1000, 4000, 16000];
const HEALTH_CHECK_POLL_INTERVAL = 200;
const SIGTERM_GRACE_MS = 5000;

export class ProcessManager {
  private readonly processes: Map<string, ProcessRecord> = new Map();
  private readonly homeDir: string;
  private readonly portPool: PortPool;
  private readonly maxProcesses: number;
  private readonly reaperInterval: ReturnType<typeof setInterval> | null;
  private shuttingDown = false;

  constructor(opts: ProcessManagerOptions) {
    this.homeDir = opts.homeDir;
    this.portPool = opts.portPool;
    this.maxProcesses = opts.maxProcesses ?? 10;

    const reaperMs = opts.reaperIntervalMs ?? 30_000;
    if (reaperMs > 0) {
      this.reaperInterval = setInterval(() => {
        this.reap().catch(() => {});
      }, reaperMs);
      // Don't keep the process alive for the reaper
      if (this.reaperInterval.unref) {
        this.reaperInterval.unref();
      }
    } else {
      this.reaperInterval = null;
    }
  }

  async ensureRunning(slug: string): Promise<ProcessRecord> {
    const existing = this.processes.get(slug);

    // If already running, return it
    if (existing && existing.state === "running") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    // If starting, return the shared startupPromise (concurrent dedup)
    if (existing && (existing.state === "starting" || existing.state === "healthy") && existing.startupPromise) {
      return existing.startupPromise;
    }

    // If failed, throw
    if (existing && existing.state === "failed") {
      throw new SpawnError(
        "spawn_failed",
        `App "${slug}" is in failed state after ${existing.restartCount} restart attempts`,
      );
    }

    // If restarting/crashed, wait for the restart to complete
    if (existing && (existing.state === "restarting" || existing.state === "crashed")) {
      // Just return the existing record's state; the restart handler will resolve it
      throw new SpawnError(
        "spawn_failed",
        `App "${slug}" is recovering from a crash`,
      );
    }

    // Evict LRU if at cap
    if (!this.processes.has(slug) && this.runningCount() >= this.maxProcesses) {
      await this.evictLRU();
    }

    // Start the spawn process
    return this.spawnApp(slug);
  }

  inspect(slug: string): ProcessRecord | undefined {
    return this.processes.get(slug);
  }

  markUsed(slug: string): void {
    const record = this.processes.get(slug);
    if (record) {
      record.lastUsedAt = Date.now();
    }
  }

  async stop(slug: string): Promise<void> {
    const record = this.processes.get(slug);
    if (!record || !record.child || record.state === "idle" || record.state === "stopping") {
      return;
    }
    await this.stopProcess(record);
  }

  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
    }

    const stopPromises: Promise<void>[] = [];
    for (const record of this.processes.values()) {
      if (record.child && record.state !== "idle" && record.state !== "stopping") {
        stopPromises.push(this.stopProcess(record));
      }
    }
    await Promise.allSettled(stopPromises);
    this.processes.clear();
  }

  private runningCount(): number {
    let count = 0;
    for (const record of this.processes.values()) {
      if (record.state === "running" || record.state === "starting" || record.state === "healthy") {
        count++;
      }
    }
    return count;
  }

  private async evictLRU(): Promise<void> {
    let lruSlug: string | null = null;
    let lruTime = Infinity;

    for (const [slug, record] of this.processes) {
      if (record.state === "running" && record.lastUsedAt < lruTime) {
        lruTime = record.lastUsedAt;
        lruSlug = slug;
      }
    }

    if (lruSlug) {
      const record = this.processes.get(lruSlug)!;
      // Mark as stopping immediately so crash handler won't schedule restarts
      record.state = "stopping";
      await this.stopProcess(record);
      this.processes.delete(lruSlug);
    }
  }

  private spawnApp(slug: string): Promise<ProcessRecord> {
    // Create record and insert into map SYNCHRONOUSLY before any await.
    // This prevents concurrent callers from racing past the dedup check.
    const record: ProcessRecord = {
      slug,
      state: "starting",
      pid: null,
      port: null,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      restartCount: 0,
      child: null,
      startupPromise: null,
    };

    this.processes.set(slug, record);

    const promise = this.doFullSpawn(record).then(
      () => {
        record.startupPromise = null;
        return record;
      },
      (err) => {
        record.startupPromise = null;
        throw err;
      },
    );

    record.startupPromise = promise;
    return promise;
  }

  private async doFullSpawn(record: ProcessRecord): Promise<void> {
    const { slug } = record;

    // Load manifest to get serve config
    const result = await loadManifest(join(this.homeDir, "apps"), slug);
    if (!result.ok) {
      this.processes.delete(slug);
      throw new SpawnError("spawn_failed", `Cannot load manifest for "${slug}": ${result.error.message}`);
    }
    const manifest = result.manifest;
    if (!manifest.serve) {
      this.processes.delete(slug);
      throw new SpawnError("spawn_failed", `App "${slug}" has no serve configuration`);
    }

    const port = this.portPool.allocate();
    record.port = port;

    await this.doSpawn(record, manifest);
  }

  private async doSpawn(record: ProcessRecord, manifest: AppManifest): Promise<void> {
    const { slug, port } = record;
    const appDir = join(this.homeDir, "apps", slug);
    const env = safeEnv({ slug, port: port!, homeDir: this.homeDir });

    const startCmd = manifest.serve!.start;
    const memoryMb = manifest.resources?.memoryMb ?? 256;

    // Apply the heap cap via NODE_OPTIONS so it reaches the actual Node
    // process regardless of launcher (`next start`, `pnpm start`, `bun run
    // start`, `node_modules/.bin/next start`, ...). Injecting into the
    // startCmd string only worked for bare `node <script>` invocations,
    // which no real fixture uses.
    env.NODE_OPTIONS = `--max-old-space-size=${memoryMb}`;

    // Use sh -c for shell interpretation (pipes, quotes, etc.)
    // Use detached + process.kill(-pid) so we can kill the entire process group
    let child: ChildProcess;
    try {
      child = spawn("sh", ["-c", startCmd], {
        cwd: appDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err: unknown) {
      this.portPool.release(port!);
      record.state = "startup_failed";
      record.lastError = {
        code: "spawn_failed",
        stderrTail: err instanceof Error ? err.message : String(err),
      };
      this.processes.delete(slug);
      throw new SpawnError("spawn_failed", `Failed to spawn "${slug}": ${err instanceof Error ? err.message : String(err)}`);
    }

    record.child = child;
    record.pid = child.pid ?? null;

    // Collect stderr for diagnostics
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4096) {
        stderrBuf = stderrBuf.slice(-2048);
      }
    });

    // Handle spawn errors (e.g., ENOENT)
    const spawnErrorPromise = new Promise<SpawnError>((resolve) => {
      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve(new SpawnError("spawn_failed", `Spawn error for "${slug}": ${err.message}`));
      });
    });

    // Handle immediate exit
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Poll health check
    const healthCheck = manifest.serve!.healthCheck;
    const startTimeout = (manifest.serve!.startTimeout ?? 10) * 1000;
    const healthUrl = `http://127.0.0.1:${port}${healthCheck}`;

    try {
      await this.pollHealthCheck(healthUrl, startTimeout, spawnErrorPromise, exitPromise, slug);
    } catch (err: unknown) {
      // Cleanup on failure
      this.killChild(record);
      this.portPool.release(port!);
      record.state = "startup_failed";
      record.lastError = {
        code: err instanceof SpawnError ? err.code : "spawn_failed",
        stderrTail: stderrBuf.slice(-2048),
      };
      this.processes.delete(slug);

      if (err instanceof SpawnError) throw err;
      throw new SpawnError("spawn_failed", `Failed to start "${slug}": ${err instanceof Error ? err.message : String(err)}`);
    }

    // Healthy -> running
    record.state = "healthy";
    record.state = "running";
    record.lastUsedAt = Date.now();

    // Attach exit handler for crash recovery
    child.removeAllListeners("exit");
    child.on("exit", (code, signal) => {
      this.onChildExit(slug, code, signal, stderrBuf);
    });
  }

  private async pollHealthCheck(
    url: string,
    timeoutMs: number,
    spawnErrorPromise: Promise<SpawnError>,
    exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    slug: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Check for spawn error first
      const spawnErr = await Promise.race([
        spawnErrorPromise.then((e) => e),
        new Promise<null>((r) => setTimeout(() => r(null), 0)),
      ]);
      if (spawnErr) throw spawnErr;

      // Check for early exit
      const exitResult = await Promise.race([
        exitPromise.then((e) => e),
        new Promise<null>((r) => setTimeout(() => r(null), 0)),
      ]);
      if (exitResult !== null) {
        throw new SpawnError(
          "spawn_failed",
          `App "${slug}" exited during startup (code=${exitResult.code}, signal=${exitResult.signal})`,
        );
      }

      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(Math.min(2000, deadline - Date.now())),
        });
        if (res.ok) {
          return; // Health check passed
        }
      } catch {
        // Connection refused or timeout — keep polling
      }

      await new Promise((r) => setTimeout(r, HEALTH_CHECK_POLL_INTERVAL));
    }

    throw new SpawnError(
      "startup_timeout",
      `Health check for "${slug}" at ${url} did not return 200 within ${timeoutMs}ms`,
    );
  }

  private onChildExit(
    slug: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
  ): void {
    const record = this.processes.get(slug);
    if (!record) return;

    if (this.shuttingDown || record.state === "stopping") {
      // Expected exit during shutdown
      record.state = "idle";
      record.child = null;
      record.pid = null;
      if (record.port !== null) {
        this.portPool.release(record.port);
        record.port = null;
      }
      return;
    }

    if (record.state === "running" || record.state === "healthy") {
      // Unexpected crash
      record.state = "crashed";
      record.child = null;
      record.pid = null;

      const isOOM = signal === "SIGKILL" || code === 137;
      record.lastError = {
        code: isOOM ? "oom_killed" : "crash",
        stderrTail: stderrTail.slice(-2048),
      };

      if (record.restartCount < MAX_RESTART_ATTEMPTS) {
        this.scheduleRestart(record);
      } else {
        record.state = "failed";
        if (record.port !== null) {
          this.portPool.release(record.port);
          record.port = null;
        }
      }
    }
  }

  private scheduleRestart(record: ProcessRecord): void {
    const delay = BACKOFF_SCHEDULE[Math.min(record.restartCount, BACKOFF_SCHEDULE.length - 1)];
    record.state = "restarting";
    record.restartCount++;

    setTimeout(async () => {
      if (this.shuttingDown) return;
      // Check if record was removed from the map (eviction or shutdown)
      if (!this.processes.has(record.slug)) return;
      if (record.state !== "restarting") return;

      try {
        const result = await loadManifest(join(this.homeDir, "apps"), record.slug);
        if (!result.ok) {
          record.state = "failed";
          if (record.port !== null) {
            this.portPool.release(record.port);
            record.port = null;
          }
          return;
        }

        // Release old port and get a new one
        if (record.port !== null) {
          this.portPool.release(record.port);
          record.port = null;
        }
        const newPort = this.portPool.allocate();
        record.port = newPort;
        record.state = "starting";

        await this.doSpawn(record, result.manifest);
      } catch (err: unknown) {
        if (record.restartCount >= MAX_RESTART_ATTEMPTS) {
          record.state = "failed";
          if (record.port !== null) {
            this.portPool.release(record.port);
            record.port = null;
          }
        } else {
          record.state = "crashed";
          record.lastError = {
            code: "restart_failed",
            stderrTail: err instanceof Error ? err.message.slice(-2048) : String(err).slice(-2048),
          };
          this.scheduleRestart(record);
        }
      }
    }, delay);
  }

  private async stopProcess(record: ProcessRecord): Promise<void> {
    if (!record.child) {
      record.state = "idle";
      if (record.port !== null) {
        this.portPool.release(record.port);
        record.port = null;
      }
      return;
    }

    record.state = "stopping";
    const child = record.child;

    // Remove the crash-recovery exit handler to prevent it from
    // interpreting a deliberate stop as a crash
    child.removeAllListeners("exit");

    return new Promise<void>((resolve) => {
      const pid = record.pid;
      const gracePeriod = setTimeout(() => {
        try {
          if (pid) process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, SIGTERM_GRACE_MS);

      const cleanup = () => {
        clearTimeout(gracePeriod);
        record.state = "idle";
        record.child = null;
        record.pid = null;
        if (record.port !== null) {
          this.portPool.release(record.port);
          record.port = null;
        }
        resolve();
      };

      child.once("exit", cleanup);

      try {
        // Kill the process group so shell + child both get the signal
        if (pid) process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // Process may already be dead
        cleanup();
      }
    });
  }

  private killChild(record: ProcessRecord): void {
    if (record.child && record.pid) {
      try {
        // Kill the entire process group (detached processes)
        process.kill(-record.pid, "SIGKILL");
      } catch {
        try {
          record.child.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
      }
      record.child = null;
      record.pid = null;
    } else if (record.child) {
      try {
        record.child.kill("SIGKILL");
      } catch {
        // Process may already be dead
      }
      record.child = null;
      record.pid = null;
    }
  }

  private async reap(): Promise<void> {
    if (this.shuttingDown) return;

    const now = Date.now();
    for (const [slug, record] of this.processes) {
      if (record.state !== "running") continue;

      // Load manifest to get idleShutdown
      const result = await loadManifest(join(this.homeDir, "apps"), slug);
      if (!result.ok) continue;

      const idleShutdownMs = (result.manifest.serve?.idleShutdown ?? 300) * 1000;
      if (now - record.lastUsedAt > idleShutdownMs) {
        await this.stopProcess(record);
      }
    }
  }
}
