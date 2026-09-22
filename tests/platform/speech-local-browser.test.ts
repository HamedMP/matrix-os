import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalFixtureVerificationError,
  startOwnedXvfb,
} from "../../scripts/lib/platform-speech-local-browser.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("local speech browser process ownership", () => {
  it("kills and reaps Xvfb before rejecting an invalid startup response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "matrix-speech-xvfb-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-xvfb");
    const statePath = join(directory, "state.json");
    await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync, writeSync } from "node:fs";
writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ pid: process.pid }));
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ pid: process.pid, signal: "SIGTERM" }));
});
writeSync(3, "invalid-display-value-that-is-too-long\\n");
setInterval(() => {}, 1000);
`);
    await chmod(executable, 0o755);

    await expect(startOwnedXvfb({
      command: executable,
      platform: "linux",
      display: undefined,
      startupTimeoutMs: 500,
      terminationGraceMs: 100,
    })).rejects.toEqual(expect.objectContaining<Partial<LocalFixtureVerificationError>>({
      code: "xvfb_invalid_display",
    }));

    const state = JSON.parse(await readFile(statePath, "utf8")) as { pid: number; signal?: string };
    expect(state.signal).toBe("SIGTERM");
    expect(() => process.kill(state.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});
