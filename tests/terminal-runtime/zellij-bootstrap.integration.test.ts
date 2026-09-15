import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTerminalRuntimeEnvironment } from "../../packages/terminal-runtime/src/runtime-environment.js";
import { initializeMatrixZellijConfig } from "../../packages/terminal-runtime/src/zellij-bootstrap.js";
import { matrixZellijConfigPaths } from "../../packages/terminal-runtime/src/zellij-config.js";

const execFileAsync = promisify(execFile);
const binary = process.env.MATRIX_TEST_ZELLIJ_BIN;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(!binary)("clean-home packaged Zellij startup", () => {
  it("reproduces the missing config failure and starts with the initialized assets", async () => {
    await access(binary!);
    expect((await execFileAsync(binary!, ["--version"], { timeout: 5_000 })).stdout.trim()).toBe("zellij 0.44.3");
    const home = await mkdtemp(join(tmpdir(), "matrix-zellij-cold-"));
    const session = `matrix-w-${randomUUID().replaceAll("-", "")}`;
    const paths = matrixZellijConfigPaths(home);
    const runtimeDir = join(home, "run");
    const layout = join(home, "start.kdl");
    const env = {
      ...createTerminalRuntimeEnvironment({ homePath: home, uid: process.getuid!(), runtimeDir }),
      ZELLIJ_CONFIG_DIR: paths.dir, ZELLIJ_CONFIG_FILE: paths.file,
      XDG_RUNTIME_DIR: runtimeDir, TERM: "xterm-256color", COLORTERM: "truecolor",
    };
    let started = false;
    try {
      await mkdir(runtimeDir, { mode: 0o700 });
      await writeFile(layout, 'layout { pane; }\n');
      // Same pinned-binary invocation and config environment as the user-unit keeper.
      const starter = [binary!, "--new-session-with-layout", layout, "attach", "--create-background", session].map(quote).join(" ");
      const start = () => execFileAsync("/usr/bin/script", ["-qefc", starter, "/dev/null"], { env, timeout: 15_000 });
      await expect(start()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(paths.file) });
      await initializeMatrixZellijConfig(home);
      await start().catch((error: unknown) => {
        const result = error as { stdout?: string; stderr?: string };
        throw new Error(`Zellij startup failed: ${result.stdout ?? ""}${result.stderr ?? ""}`, { cause: error });
      });
      started = true;
      const sessions = await execFileAsync(binary!, ["list-sessions", "--no-formatting"], { env, timeout: 5_000 });
      expect(sessions.stdout).toContain(session);
      expect((await execFileAsync(binary!, ["--session", session, "action", "dump-layout"], { env, timeout: 5_000 })).stdout).toContain("layout");
    } finally {
      try {
        if (started) {
          await execFileAsync(binary!, ["delete-session", session, "--force"], { env, timeout: 5_000 }).catch((error: unknown) => {
            // A very young session can be killed before its resurrection cache exists.
            if (!(error instanceof Error) || !("stderr" in error) || !String(error.stderr).includes(`Session: "${session}" not found.`)) throw error;
            console.warn("Test session stopped before resurrection metadata was written");
          });
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }, 40_000);
});
