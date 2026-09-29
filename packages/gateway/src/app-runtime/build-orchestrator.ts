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
const BUILD_LOG_WRITE_TIMEOUT_MS = 5_000;
// After a timeout SIGKILLs the build's process group, wait at most this long
// for every member to disappear before reporting the timeout anyway.
const BUILD_KILL_WAIT_MS = 5_000;
const BUILD_KILL_POLL_MS = 20;

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
      let timedOut = false;
      let settled = false;

      const env = safeBuildEnv({ storeDir: this.storeDir });

      // Invoke the manifest command through `sh -c` so quoted/embedded args
      // (e.g. `pnpm run "build:prod"`) are parsed by the shell rather than
      // naively split on whitespace. Process-manager uses the same pattern
      // for the serve command. `detached` puts the shell in its own process
      // group so a timeout can kill everything it forked (pnpm, vite,
      // postinstall scripts), not just the shell itself.
      const child = spawn("sh", ["-c", command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

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

      const writeBuildLog = async (output: string): Promise<void> => {
        try {
          await writeFile(logPath, output.slice(0, MAX_LOG_SIZE), {
            signal: AbortSignal.timeout(BUILD_LOG_WRITE_TIMEOUT_MS),
          });
        } catch (writeErr: unknown) {
          console.warn(`[build-orchestrator] log write to ${logPath} failed:`, writeErr);
        }
      };

      const finish = (result: BuildResult, output: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void writeBuildLog(output).finally(() => resolve(result));
      };

      // A timeout resolves only once the whole process group is gone, so no
      // orphaned install/build step keeps writing into the app directory
      // after the caller has released the slug mutex and semaphore slot.
      const timer = setTimeout(() => {
        timedOut = true;
        void killBuildProcessGroup(child.pid).then(() => {
          finish({
            ok: false,
            error: new BuildError(
              "timeout",
              stage,
              null,
              `Build timed out after ${timeoutMs}ms`,
            ),
          }, Buffer.concat(chunks).toString("utf8"));
        });
      }, timeoutMs);

      child.on("error", () => {
        if (timedOut) return;
        const output = Buffer.concat(chunks).toString("utf8");
        finish({
          ok: false,
          error: new BuildError("install_failed", stage, null, output.slice(-2048)),
        }, output);
      });

      child.on("close", (code) => {
        if (timedOut) return;
        const output = Buffer.concat(chunks).toString("utf8");
        const stderrTail = output.slice(-2048);

        if (code !== 0) {
          finish({
            ok: false,
            error: new BuildError(
              stage === "install" ? "install_failed" : "build_failed",
              stage,
              code,
              stderrTail,
            ),
          }, output);
          return;
        }

        finish(
          { ok: true, stamp: { sourceHash: "", lockfileHash: "", builtAt: 0, exitCode: 0 } },
          output,
        );
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

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means a member still exists but can no longer be signalled.
    if (code === "EPERM") return true;
    throw err;
  }
}

async function killBuildProcessGroup(pgid: number | undefined): Promise<void> {
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    console.warn("[build-orchestrator] SIGKILL of build process group failed:", err);
    return;
  }

  const deadline = Date.now() + BUILD_KILL_WAIT_MS;
  try {
    while (processGroupAlive(pgid)) {
      if (Date.now() >= deadline) {
        console.warn(`[build-orchestrator] build process group ${pgid} still alive ${BUILD_KILL_WAIT_MS}ms after SIGKILL`);
        return;
      }
      await new Promise((r) => setTimeout(r, BUILD_KILL_POLL_MS));
    }
  } catch (err: unknown) {
    console.warn("[build-orchestrator] probing build process group failed:", err);
  }
}
