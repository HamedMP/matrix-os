import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Zellij smoke supervisor", () => {
  it.each([false, true])("cleans an interrupted worker and preserves its error (cleanup fails: %s)", async (cleanupFails) => {
    const root = await mkdtemp(join(tmpdir(), "mzc-supervisor-"));
    const marker = join(root, "started.json");
    const cleaned = join(root, "cleaned");
    const binary = join(root, "fake-zellij");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'kill-session') {
  const original = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, 'utf8'));
  try { process.kill(original.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  fs.writeFileSync(${JSON.stringify(cleaned)}, 'yes');
  process.exit(${cleanupFails ? 1 : 0});
}
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, fixture:process.env.HOME}));
setTimeout(() => process.exit(0), 10000);
`);
      await chmod(binary, 0o700);
      child = spawn(process.execPath, ["--import", "tsx", "scripts/smoke-zellij-session-config.ts", binary], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (data) => { stderr = (stderr + data).slice(-65_536); });
      child.stdout!.resume();
      const closed = new Promise<number | null>((done) => child!.once("close", done));
      await expect.poll(async () => readFile(marker, "utf8").then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }), { timeout: 4_000 }).toBe(true);
      const { fixture } = JSON.parse(await readFile(marker, "utf8"));
      child.kill("SIGTERM");
      expect(await closed).not.toBe(0);
      expect(stderr).toContain("AbortError");
      if (cleanupFails) expect(stderr).toContain("Zellij smoke cleanup failed");
      await expect(readFile(cleaned, "utf8")).resolves.toBe("yes");
      await expect(readFile(join(fixture, "session"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
