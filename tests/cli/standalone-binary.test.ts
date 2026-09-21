import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("standalone CLI binary", () => {
  it("dispatches the hidden sync daemon without the build-only runtime variable", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "matrix-standalone-daemon-"));
    const homeDir = join(tempRoot, "home");
    const binaryPath = join(tempRoot, process.platform === "win32" ? "matrix.exe" : "matrix");
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
      const daemon = spawnSync(binaryPath, ["__daemon"], {
        cwd: tempRoot,
        encoding: "utf8",
        env: { ...runtimeEnv, HOME: homeDir },
        timeout: 20_000,
      });
      const output = `${daemon.stdout}\n${daemon.stderr}`;
      expect(daemon.status, output).toBe(1);
      expect(output).not.toContain("Unknown command");
      expect(output).not.toContain("_flushSync took too long");
      expect(await readFile(join(homeDir, ".matrixos/logs/sync.log"), "utf8"))
        .toContain("No config found. Run 'matrixos sync <path>' first.");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
