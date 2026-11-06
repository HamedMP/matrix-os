import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createRuntimeDirectories } from "../../packages/scope-runtime/src/runtime-directories.js";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(namespaced: boolean) {
  const root = await createUnixSocketTempDir(); roots.push(root);
  const identity = commandIdentityFixture(root), stateRoot = join(root, "s");
  await mkdir(join(stateRoot, "runtimes"), { recursive: true });
  for (const path of [stateRoot, join(stateRoot, "runtimes")]) await chmod(path, 0o2700);
  const commandSocketRoot = namespaced ? join(root, "c") : undefined;
  if (commandSocketRoot) { await mkdir(commandSocketRoot); await chmod(commandSocketRoot, 0o2770); }
  return { ...identity, stateRoot, commandSocketRoot };
}
it.each([false, true])("preserves PID1 setgid anchors and inherits private/command modes (namespaced=%s)", async namespaced => {
  const paths = await fixture(namespaced), mask = process.umask();
  const created = await createRuntimeDirectories(paths, "runtime_" + "a".repeat(32));
  expect(process.umask()).toBe(mask);
  for (const path of [paths.stateRoot, join(paths.stateRoot, "runtimes"), created.runtimeRoot]) {
    expect((await lstat(path)).mode & 0o7777).toBe(0o2700);
  }
  if (paths.commandSocketRoot) expect((await lstat(paths.commandSocketRoot)).mode & 0o7777).toBe(0o2770);
  expect((await lstat(created.commandDirectory)).mode & 0o7777).toBe(0o2733);
});
it.each([0o700, 0o770, 0o2777])("rejects missing/wrong inheritance without upgrading an existing anchor: %s", async mode => {
  const paths = await fixture(true);
  await chmod(join(paths.stateRoot, "runtimes"), mode);
  await expect(createRuntimeDirectories(paths, "runtime_" + "b".repeat(32))).rejects.toThrow();
  expect((await lstat(join(paths.stateRoot, "runtimes"))).mode & 0o7777).toBe(mode);
});
it("preserves a preexisting command collision", async () => {
  const paths = await fixture(true), suffix = "c".repeat(32), collision = join(paths.commandSocketRoot!, suffix);
  await mkdir(collision); await writeFile(join(collision, "sentinel"), "foreign");
  await expect(createRuntimeDirectories(paths, "runtime_" + suffix)).rejects.toThrow();
  expect(await readFile(join(collision, "sentinel"), "utf8")).toBe("foreign");
});

it("requires PID1 to supply every anchor; it never creates missing ones", async () => {
  const paths = await fixture(true), runts = join(paths.stateRoot, "runtimes");
  await rm(runts, { recursive: true });
  await expect(createRuntimeDirectories({ ...paths, directoryOperations: undefined }, "runtime_" + "d".repeat(32))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(runts)).rejects.toMatchObject({ code: "ENOENT" });
});
