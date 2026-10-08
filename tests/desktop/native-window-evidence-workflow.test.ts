import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const evidence = resolve(import.meta.dirname, "../../specs/544-windowed-app-content/evidence");

it("preserves a failed native test exit status after documented scratch cleanup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "matrix-evidence-recipe-"));
  try {
    await mkdir(join(fixture, "bin"));
    await mkdir(join(fixture, "tests/e2e/desktop"), { recursive: true });
    await mkdir(join(fixture, "specs/544-windowed-app-content/evidence"), { recursive: true });
    await writeFile(join(fixture, "specs/544-windowed-app-content/evidence/probe.ts"), "synthetic probe");
    await writeFile(join(fixture, "bin/bun"), '#!/bin/sh\nif [ "$2" = "build:desktop" ]; then exit 0; fi\nexit 7\n', { mode: 0o755 });
    const readme = await readFile(join(evidence, "README.md"), "utf8");
    const recipe = readme.match(/```sh\n([\s\S]*?)\n```/)![1];
    const result = spawnSync("sh", ["-c", recipe], { cwd: fixture, timeout: 10000, env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}` } });
    expect(result.status).toBe(7);
    expect(existsSync(join(fixture, "tests/e2e/desktop/native-window-evidence-pr2113.e2e.test.ts"))).toBe(false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

it("protects an existing scratch probe before starting reproduction", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "matrix-evidence-owner-"));
  try {
    const scratch = join(fixture, "tests/e2e/desktop/native-window-evidence-pr2113.e2e.test.ts");
    await mkdir(join(fixture, "tests/e2e/desktop"), { recursive: true });
    await mkdir(join(fixture, "bin"));
    await writeFile(join(fixture, "bin/bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(scratch, "owner test");
    const recipe = (await readFile(join(evidence, "README.md"), "utf8")).match(/```sh\n([\s\S]*?)\n```/)![1];
    expect(spawnSync("sh", ["-c", recipe], { cwd: fixture, timeout: 10000, env: { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH}` } }).status).toBe(1);
    expect(await readFile(scratch, "utf8")).toBe("owner test");
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

it("cleans acquired resources when startup fails", async () => {
  const { withEvidenceCleanup } = await import("../../specs/544-windowed-app-content/evidence/cleanup");
  const fixture = await mkdtemp(join(tmpdir(), "matrix-evidence-startup-"));
  try {
    await expect(withEvidenceCleanup(async (register) => {
      register(() => rm(fixture, { recursive: true, force: true }));
      throw new Error("synthetic startup failure");
    })).rejects.toThrow("synthetic startup failure");
    expect(existsSync(fixture)).toBe(false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

it("attempts every cleanup in reverse acquisition order after a close failure", async () => {
  const { withEvidenceCleanup } = await import("../../specs/544-windowed-app-content/evidence/cleanup");
  const closed: string[] = [];
  await expect(withEvidenceCleanup(async (register) => {
    register(async () => { closed.push("profile"); });
    register(async () => { closed.push("gateway"); });
    register(async () => { closed.push("proxy"); });
    register(async () => { closed.push("electron"); throw new Error("synthetic close failure"); });
  })).rejects.toThrow("Evidence cleanup failed");
  expect(closed).toEqual(["electron", "proxy", "gateway", "profile"]);
});

it("retains the probe failure and cleanup failures together", async () => {
  const { withEvidenceCleanup } = await import("../../specs/544-windowed-app-content/evidence/cleanup");
  let thrown: unknown;
  try {
    await withEvidenceCleanup(async (register) => {
      register(async () => { throw new Error("close failure"); });
      throw new Error("probe failure");
    });
  } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).errors.map((error) => error.message)).toEqual(["probe failure", "close failure"]);
});
