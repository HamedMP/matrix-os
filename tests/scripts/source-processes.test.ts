import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnServices } from "../../scripts/source-processes.mjs";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once("close", resolve));
}

it.skipIf(process.platform === "win32")("reaps a TERM-resistant descendant after its service leader exits, without touching another group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-source-processes-"));
  const receipt = join(directory, "owned-pids.json");
  let owned: { leader: number; descendant: number } | undefined;
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore",
  });
  let services: ReturnType<typeof spawnServices> | undefined;
  try {
    const descendant = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.send("ready");`;
    const leader = `
      import { spawn } from "node:child_process";
      import { rename, writeFile } from "node:fs/promises";
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      process.on("SIGTERM", () => process.exit(0));
      child.once("message", async () => {
        await writeFile(${JSON.stringify(receipt + ".tmp")}, JSON.stringify({ leader: process.pid, descendant: child.pid }));
        await rename(${JSON.stringify(receipt + ".tmp")}, ${JSON.stringify(receipt)});
      });
      setInterval(() => {}, 1000);
    `;
    services = spawnServices([{ name: "owned-fixture", args: ["--input-type=module", "-e", leader] }]);
    const deadline = performance.now() + 5000;
    while (!owned) {
      try { owned = JSON.parse(await readFile(receipt, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!owned) {
        if (performance.now() >= deadline) throw new Error("Owned descendant did not become ready");
        await pause(20);
      }
    }
    expect(alive(owned.descendant)).toBe(true);
    const stopStarted = performance.now();
    await services.stop("SIGTERM");
    expect(performance.now() - stopStarted).toBeGreaterThanOrEqual(4500);
    expect(alive(owned.leader)).toBe(false);
    expect(alive(owned.descendant)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
    await expect(services.exited).resolves.toMatchObject({ name: "owned-fixture", code: 0 });
  } finally {
    // Keep the original implementation's red run isolated too. These are only
    // the process groups created by this test, never a process-table scan.
    if (owned) {
      try { process.kill(-owned.leader, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    try { await services?.stop("SIGTERM"); }
    finally {
      unrelated.kill("SIGKILL");
      await exited(unrelated);
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 15000);

it("preserves a failing service's exit status while stopping its owned process", async () => {
  const services = spawnServices([{ name: "failed-fixture", args: ["-e", "process.exit(17)"] }]);
  try { await expect(services.exited).rejects.toThrow(/failed-fixture \(pid \d+\) exited with 17/); }
  finally { await services.stop("SIGTERM"); }
});

it("reports a service that fails to spawn and still completes cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-source-spawn-failure-"));
  const services = spawnServices([{ name: "missing-fixture", cwd: join(directory, "missing"), args: ["-e", ""] }]);
  try { await expect(services.exited).rejects.toThrow("missing-fixture failed to start"); }
  finally {
    await services.stop("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
