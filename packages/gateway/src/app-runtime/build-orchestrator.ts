import { spawn } from "node:child_process";
import { readFile, writeFile, stat, truncate, open } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { BuildError } from "./errors.js";
import {
  hashSources,
  hashLockfile,
  readBuildStamp,
  writeBuildStamp,
  isBuildStale,
  type BuildStamp,
} from "./build-cache.js";
import { parseManifest, type AppManifest } from "./manifest-schema.js";
import { safeBuildEnv } from "./safe-env.js";

export type BuildResult =
  | { ok: true; stamp: BuildStamp }
  | { ok: false; error: BuildError };

interface BuildOrchestratorOptions {
  concurrency: number;
  storeDir?: string;
}

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB

export class BuildOrchestrator {
  private readonly concurrency: number;
  private readonly storeDir: string | undefined;
  private readonly slugMutex = new Map<string, Promise<BuildResult>>();
  private activeBuildCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(opts: BuildOrchestratorOptions) {
    this.concurrency = opts.concurrency;
    this.storeDir = opts.storeDir;
  }

  async build(
    slug: string,
    appDir: string,
    opts?: { timeoutMs?: number },
  ): Promise<BuildResult> {
    // Per-slug mutex: serialize concurrent builds for the same slug
    const existing = this.slugMutex.get(slug);
    if (existing) {
      return existing;
    }

    const promise = this.doBuild(slug, appDir, opts);
    this.slugMutex.set(slug, promise);
    try {
      return await promise;
    } finally {
      this.slugMutex.delete(slug);
    }
  }

  private async doBuild(
    slug: string,
    appDir: string,
    opts?: { timeoutMs?: number },
  ): Promise<BuildResult> {
    // Read manifest to get build config
    let manifest: AppManifest;
    try {
      const raw = await readFile(join(appDir, "matrix.json"), "utf8");
      const parsed = JSON.parse(raw);
      const result = await parseManifest(parsed);
      if (!result.ok) {
        return {
          ok: false,
          error: new BuildError("build_failed", "prepare", null, result.error.message),
        };
      }
      manifest = result.manifest;
    } catch (err: unknown) {
      return {
        ok: false,
        error: new BuildError(
          "build_failed",
          "prepare",
          null,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }

    if (!manifest.build) {
      return {
        ok: false,
        error: new BuildError("build_failed", "prepare", null, "manifest has no build section"),
      };
    }

    const sourceGlobs = manifest.build.sourceGlobs;
    const timeoutMs = opts?.timeoutMs ?? manifest.build.timeout * 1000;

    // Check if build is stale
    if (!(await isBuildStale(appDir, sourceGlobs))) {
      const stamp = await readBuildStamp(appDir);
      if (stamp) {
        return { ok: true, stamp };
      }
    }

    // Acquire cross-slug semaphore slot
    await this.acquireSemaphore();

    try {
      // Run install
      const installResult = await this.runCommand(
        manifest.build.install,
        appDir,
        "install",
        timeoutMs,
      );
      if (!installResult.ok) {
        return installResult;
      }

      // Run build
      const buildResult = await this.runCommand(
        manifest.build.command,
        appDir,
        "build",
        timeoutMs,
      );
      if (!buildResult.ok) {
        return buildResult;
      }

      // Write stamp on success
      const sourceHash = await hashSources(appDir, sourceGlobs);
      const lockHash = await hashLockfile(appDir);
      const stamp: BuildStamp = {
        sourceHash,
        lockfileHash: lockHash,
        builtAt: Date.now(),
        exitCode: 0,
      };
      await writeBuildStamp(appDir, stamp);

      return { ok: true, stamp };
    } finally {
      this.releaseSemaphore();
    }
  }

  private async runCommand(
    command: string,
    cwd: string,
    stage: "install" | "build",
    timeoutMs: number,
  ): Promise<BuildResult> {
    const logPath = join(cwd, ".build.log");

    return new Promise<BuildResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const env = safeBuildEnv({ storeDir: this.storeDir });

      // Invoke the manifest command through `sh -c` so quoted/embedded args
      // (e.g. `pnpm run "build:prod"`) are parsed by the shell rather than
      // naively split on whitespace. Process-manager uses the same pattern
      // for the serve command.
      const child = spawn("sh", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const killProcessTree = (signal: NodeJS.Signals) => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch (err: unknown) {
            const code = err instanceof Error && "code" in err
              ? (err as NodeJS.ErrnoException).code
              : undefined;
            if (code !== "ESRCH") {
              console.warn("[build-orchestrator] failed to kill process group:", err);
            }
          }
        }
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree("SIGTERM");
        forceKillTimer = setTimeout(() => killProcessTree("SIGKILL"), 1_000);
        forceKillTimer.unref?.();
      }, timeoutMs);

      // Ring-buffer output to cap memory. A verbose pnpm install / vite build
      // can emit hundreds of MB of logs; accumulating all of it would OOM the
      // gateway. We keep the most recent MAX_LOG_SIZE bytes, which is what the
      // log writer and stderrTail slice would use anyway.
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const appendChunk = (data: Buffer) => {
        chunks.push(data);
        totalBytes += data.length;
        while (totalBytes > MAX_LOG_SIZE && chunks.length > 1) {
          const dropped = chunks.shift();
          if (dropped) totalBytes -= dropped.length;
        }
      };

      child.stdout?.on("data", appendChunk);
      child.stderr?.on("data", appendChunk);

      const writeLog = async (output: string) => {
        try {
          await writeFile(logPath, output.slice(0, MAX_LOG_SIZE));
        } catch (writeErr: unknown) {
          console.warn(`[build-orchestrator] log write to ${logPath} failed:`, writeErr);
        }
      };

      const resolveOnce = (result: BuildResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const resolveTimeout = (code: number | null) => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const output = Buffer.concat(chunks).toString("utf8");
        void writeLog(output).finally(() => {
          resolveOnce({
            ok: false,
            error: new BuildError(
              "timeout",
              stage,
              code,
              `Build timed out after ${timeoutMs}ms`,
            ),
          });
        });
      };

      child.on("error", (err) => {
        if (timedOut) {
          killProcessTree("SIGKILL");
          resolveTimeout(null);
          return;
        }
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("utf8");
        const stderrTail = output.slice(-2048);
        void writeLog(output).finally(() => {
          resolveOnce({
            ok: false,
            error: new BuildError(
              stage === "install" ? "install_failed" : "build_failed",
              stage,
              null,
              stderrTail || err.message,
            ),
          });
        });
      });

      child.on("close", (code) => {
        if (timedOut) {
          resolveTimeout(code);
          return;
        }
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        const output = Buffer.concat(chunks).toString("utf8");
        const stderrTail = output.slice(-2048);

        void writeLog(output).finally(() => {
          if (code !== 0) {
            resolveOnce({
              ok: false,
              error: new BuildError(
                stage === "install" ? "install_failed" : "build_failed",
                stage,
                code,
                stderrTail,
              ),
            });
            return;
          }

          resolveOnce({ ok: true, stamp: { sourceHash: "", lockfileHash: "", builtAt: 0, exitCode: 0 } });
        });
      });
    });
  }

  private acquireSemaphore(): Promise<void> {
    if (this.activeBuildCount < this.concurrency) {
      this.activeBuildCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.activeBuildCount++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.activeBuildCount--;
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }
}
