import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createShellCommandRunner } from "../../packages/gateway/src/shell/command-runner.js";

describe("shell command runner", () => {
  it("captures stdout stderr and exit status in a home-contained cwd", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-run-"));
    try {
      await writeFile(join(homePath, "file.txt"), "ok");
      const runner = createShellCommandRunner({ homePath, defaultTimeoutMs: 1_000 });

      const result = await runner.run({
        command: [
          process.execPath,
          "-e",
          "console.log(require('fs').readdirSync('.').join(',')); console.error('warn'); process.exit(7)",
        ],
        cwd: "~",
      });

      expect(result.stdout).toBe("file.txt\n");
      expect(result.stderr).toBe("warn\n");
      expect(result.exitCode).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.truncated).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("reports when stdout or stderr is truncated", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-run-"));
    try {
      const runner = createShellCommandRunner({
        homePath,
        defaultTimeoutMs: 1_000,
        maxOutputBytes: 4,
      });

      const result = await runner.run({
        command: [
          process.execPath,
          "-e",
          "process.stdout.write('abcdef'); process.stderr.write('warn')",
        ],
        cwd: "~",
      });

      expect(result.stdout).toBe("abcd");
      expect(result.stderr).toBe("warn");
      expect(result.truncated).toBe(true);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("rejects cwd traversal before spawning", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-shell-run-"));
    try {
      const runner = createShellCommandRunner({ homePath });

      await expect(runner.run({ command: ["ls"], cwd: "../outside" })).rejects.toMatchObject({
        code: "invalid_cwd",
      });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
