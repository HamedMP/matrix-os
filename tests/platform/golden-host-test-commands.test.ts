import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createGoldenHostTestCommands } from "../helpers/golden-host-test-commands.js";

const execFileAsync = promisify(execFile);

it("keeps real deadlines and kill-after escalation in copied prerequisite fixtures", async () => {
  const commands = await createGoldenHostTestCommands(process.env.PATH ?? "");
  const directory = await mkdtemp(join(tmpdir(), "matrix-golden-timeout-test-"));
  let childPid: number | undefined;
  try {
    const source = join(directory, "source");
    const fixture = join(directory, "fixture");
    await writeFile(source, '#!/bin/sh\nexec /usr/bin/timeout --kill-after=0.2 0.5 /usr/bin/python3 -I -c "$1"\n', { mode: 0o755 });
    await commands.copyPrerequisiteFixture(source, fixture);

    await expect(execFileAsync(fixture, ['print("completed")'], {
      timeout: 5_000, killSignal: "SIGKILL",
    })).resolves.toMatchObject({ stdout: "completed\n" });

    // Ignoring TERM requires the real --kill-after escalation. The outer
    // deadline is only a safety net; killed:false proves it did not fire.
    const pidFile = join(directory, "child.pid");
    const startedAt = Date.now();
    const failure = await execFileAsync(fixture, [
      `import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())); print("started", flush=True); time.sleep(30); print("escaped")`,
    ], { timeout: 5_000, killSignal: "SIGKILL" }).then(() => expect.fail("TERM-ignoring child escaped"), (error) => error);
    childPid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    const pid = childPid;
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
        throw error;
      }
    }).toBe(false);
    childPid = undefined;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(failure).toMatchObject({
      killed: false,
      stdout: "started\n",
    });
    // GNU timeout dies by KILL; Ubuntu 26.04's uutils reaps its child and exits 137.
    // Require a coherent KILL representation in addition to actual child absence.
    expect([{ code: null, signal: "SIGKILL" }, { code: 137, signal: null }])
      .toContainEqual({ code: failure.code, signal: failure.signal });
  } finally {
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await rm(directory, { recursive: true, force: true });
    await commands.cleanup();
  }
});
