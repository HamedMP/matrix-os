import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

async function waitForDirectory(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The daemon creates its private log directory asynchronously at startup.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for standalone daemon directory: ${path}`);
}

describe("standalone CLI binary", () => {
  it("dispatches the hidden sync daemon without the build-only runtime variable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-daemon-"));
    const homeDir = join(tempRoot, "home");
    const binaryPath = join(tempRoot, process.platform === "win32" ? "matrix.exe" : "matrix");
    let daemon: ChildProcess | undefined;

    try {
      await mkdir(homeDir, { recursive: true });
      const build = spawnSync(
        "bun",
        [
          "build",
          resolve(repoRoot, "packages/sync-client/src/cli/index.ts"),
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          binaryPath,
          "--define",
          'process.env.MATRIX_CLI_STANDALONE="1"',
          "--define",
          'process.env.MATRIX_CLI_VERSION="compiled-smoke"',
        ],
        { cwd: repoRoot, encoding: "utf8", env: process.env },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

      const { MATRIX_CLI_STANDALONE: _buildOnlyMarker, ...runtimeEnv } = process.env;
      daemon = spawn(binaryPath, ["__daemon"], {
        cwd: tempRoot,
        env: { ...runtimeEnv, HOME: homeDir },
        stdio: "ignore",
      });
      // startDaemon creates this directory before reading configuration. Its
      // presence proves __daemon reached the daemon entrypoint without relying
      // on transport buffering before process.exit on a missing configuration.
      await waitForDirectory(join(homeDir, ".matrixos/logs"));
    } finally {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const closed = new Promise<void>((resolveClose) => daemon?.once("close", () => resolveClose()));
        daemon.kill("SIGKILL");
        await closed;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
