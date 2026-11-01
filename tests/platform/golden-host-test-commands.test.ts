import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createGoldenHostTestCommands } from "../helpers/golden-host-test-commands.js";

const execFileAsync = promisify(execFile);

it("keeps real deadlines and kill-after escalation in copied prerequisite fixtures", async () => {
  const commands = await createGoldenHostTestCommands(process.env.PATH ?? "");
  const directory = await mkdtemp(join(tmpdir(), "matrix-golden-timeout-test-"));
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
    await expect(execFileAsync(fixture, [
      'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print("started", flush=True); time.sleep(30); print("escaped")',
    ], { timeout: 5_000, killSignal: "SIGKILL" })).rejects.toMatchObject({
      killed: false,
      signal: "SIGKILL",
      stdout: "started\n",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await commands.cleanup();
  }
});
