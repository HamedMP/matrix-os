import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runner = resolve("packages/gateway/src/coding-agents/background-agent-runner.mjs");
describe("background runner process", () => {
  it("keeps stdin open between turns, drains output with bounded logs, and forwards stop", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-background-runner-"));
    const launch = join(home, "launch.json");
    await writeFile(launch, JSON.stringify({ launch: { command: process.execPath, args: ["-e", `
      process.stdin.resume();
      process.stdin.on('end', () => { process.stderr.write('unexpected EOF'); process.exit(9); });
      process.stdout.write('x'.repeat(3 * 1024 * 1024), () => process.stdout.write('READY\\n'));
      process.on('SIGTERM', () => { process.stderr.write('STOPPED\\n'); process.exit(0); });
    `], cwd: home, env: {} } }), { mode: 0o600 });
    const child = spawn(process.execPath, [runner, launch], { stdio: "ignore" });
    const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    try {
      await expect.poll(async () => {
        try { return (await readFile(join(home, "output.log"), "utf8")).includes("READY"); }
        catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      }, { timeout: 5_000 }).toBe(true);
      expect(child.exitCode).toBeNull();
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      const output = await readFile(join(home, "output.log"), "utf8");
      expect(output).toContain("STOPPED");
      expect(output).not.toContain("unexpected EOF");
      for (const file of ["output.log", "output.log.1"]) {
        const info = await stat(join(home, file));
        expect(info.size).toBeLessThanOrEqual(1024 * 1024);
        expect(info.mode & 0o777).toBe(0o600);
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  });
});
