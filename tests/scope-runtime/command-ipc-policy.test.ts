import { chmod, link, lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertCommandDirectory, assertCommandSocket } from "../../packages/scope-runtime/src/command-ipc-policy.js";
import { createRuntimeDirectories } from "../../packages/scope-runtime/src/runtime-directories.js";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const identity = commandIdentityFixture(root);
  return { root, paths: { stateRoot: join(root, "s"), commandSocketRoot: join(root, "c"), namespaceTrust: identity.namespaceTrust },
    trust: { uid: identity.namespaceTrust.uid, gid: identity.namespaceTrust.ipcGid, workloadUid: process.getuid!() } };
}
it("exclusively creates only a trusted setgid command leaf, preserving collisions and outer roots", async () => {
  const { paths, trust } = await fixture(), handle = "runtime_" + "a".repeat(32);
  const created = await createRuntimeDirectories(paths, handle);
  const entry = await lstat(created.commandDirectory);
  expect(entry.mode & 0o7777).toBe(0o2733); expect(entry.gid).toBe(trust.gid);
  expect(() => assertCommandDirectory(entry, trust)).not.toThrow();
  expect((await lstat(paths.commandSocketRoot)).mode & 0o7777).toBe(0o700);
  await writeFile(join(created.commandDirectory, "sentinel"), "owner");
  await expect(createRuntimeDirectories(paths, handle)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(created.commandDirectory, "sentinel"), "utf8")).toBe("owner");
  const suffix = "b".repeat(32), collision = join(paths.commandSocketRoot, suffix);
  await mkdir(collision); await chmod(collision, 0o711);
  await expect(createRuntimeDirectories(paths, "runtime_" + suffix)).rejects.toMatchObject({ code: "EEXIST" });
  expect((await lstat(collision)).mode & 0o7777).toBe(0o711);
  await expect(lstat(join(paths.stateRoot, "runtimes", suffix))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects a wrong trusted group without broadening or leaving a runtime", async () => {
  const { paths } = await fixture(); paths.namespaceTrust.ipcGid++;
  await expect(createRuntimeDirectories(paths, "runtime_" + "a".repeat(32))).rejects.toThrow("Unsafe");
  await expect(lstat(join(paths.stateRoot, "runtimes", "a".repeat(32)))).rejects.toMatchObject({ code: "ENOENT" });
});
it("checks real socket and directory stats against independently supplied owner, group and exact mode", async () => {
  const { paths, trust } = await fixture();
  const { commandDirectory } = await createRuntimeDirectories(paths, "runtime_" + "a".repeat(32));
  const path = join(commandDirectory, "worker.sock"), server = createServer();
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  await chmod(path, 0o620);
  const socket = await lstat(path), parent = await lstat(commandDirectory);
  expect(() => assertCommandSocket(socket, trust)).not.toThrow();
  for (const invalid of [{ ...trust, workloadUid: trust.workloadUid + 1 }, { ...trust, gid: trust.gid + 1 }]) {
    expect(() => assertCommandSocket(socket, invalid)).toThrow("Unsafe");
  }
  for (const invalid of [{ ...trust, uid: trust.uid + 1 }, { ...trust, gid: trust.gid + 1 }]) {
    expect(() => assertCommandDirectory(parent, invalid)).toThrow("Unsafe");
  }
  await link(path, path + ".alias");
  const linked = await lstat(path); expect(() => assertCommandSocket(linked, trust)).toThrow("Unsafe");
  await unlink(path + ".alias");
  for (const mode of [0o600, 0o666, 0o1620]) { await chmod(path, mode); const entry = await lstat(path); expect(() => assertCommandSocket(entry, trust)).toThrow("Unsafe"); }
  for (const mode of [0o733, 0o2777, 0o2700]) { await chmod(commandDirectory, mode); const entry = await lstat(commandDirectory); expect(() => assertCommandDirectory(entry, trust)).toThrow("Unsafe"); }
});
