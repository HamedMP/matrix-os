import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDirectoryCreatorAdmission } from "../../packages/scope-runtime/src/directory-creator-admission.js";
import { createInheritedCommandDirectory, directoryChildArgs, waitForDirectoryChild } from "../../packages/scope-runtime/src/inherited-command-directory.js";
import { commandIdentityFixture, portableDirectoryChild } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await createUnixSocketTempDir(); roots.push(root); commandIdentityFixture(root);
  const parent = join(root, "p"); await mkdir(parent); await chmod(parent, 0o2700);
  return { root, parent, path: join(parent, "command"), trust: { uid: process.getuid!(), gid: process.getgid!() } };
}
it("runs the fixed child with a real inherited fd and isolates its zero mask from parent0007", async () => {
  const { parent, path } = await fixture(), fd = await open(parent, "r"), original = process.umask(0o007);
  try {
    const request = { parentFd: fd.fd, parentPath: parent, leaf: "command", parent: await fd.stat() };
    await waitForDirectoryChild(spawn(process.platform === "linux" ? "/usr/bin/mkdir" : "/bin/mkdir", directoryChildArgs(request,
      process.platform === "linux" ? "/proc/self/fd/3" : parent), { env: {}, stdio: ["ignore", "pipe", "pipe", fd.fd] }));
    expect(process.umask()).toBe(0o007);
    // Darwin does not inherit SGID; this assertion covers the real0733 syscall.
    expect((await lstat(path)).mode & 0o7777).toBe(process.platform === "linux" ? 0o2733 : 0o733);
  } finally { process.umask(original); await fd.close(); }
});
it.each(["success", "failure", "timeout", "mode", "replacement"])("closes parent descriptors and checks exact parent/result identity: %s", async outcome => {
  const { parent, path, trust } = await fixture(); let descriptor = -1;
  const operation = createInheritedCommandDirectory(path, trust, 0o2700, async request => {
    descriptor = request.parentFd;
    expect(fstatSync(descriptor).ino).toBe(request.parent.ino);
    if (outcome === "failure") throw new Error("uncertain child");
    if (outcome === "timeout") return waitForDirectoryChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"],
      { env: {}, stdio: ["ignore", "pipe", "pipe", request.parentFd] }), 100);
    await portableDirectoryChild(request);
    if (outcome === "mode") await chmod(path, 0o733);
    if (outcome === "replacement") { await rename(parent, parent + "-old"); await mkdir(parent); await chmod(parent, 0o2700); }
  });
  if (outcome === "success") await expect(operation).resolves.toBeUndefined();
  else await expect(operation).rejects.toThrow();
  expect(() => fstatSync(descriptor)).toThrow();
  if (outcome === "mode") expect((await lstat(path)).mode & 0o7777).toBe(0o733);
  if (outcome === "replacement") expect((await lstat(join(parent + "-old", "command"))).isDirectory()).toBe(true);
});
it.each(["uid", "gid", "mode", "symlink"])("rejects an untrusted parent before executing any child: %s", async fault => {
  const { parent, path, trust } = await fixture(), run = vi.fn(portableDirectoryChild);
  if (fault === "uid") trust.uid++;
  if (fault === "gid") trust.gid++;
  if (fault === "mode") await chmod(parent, 0o700);
  if (fault === "symlink") { await rename(parent, parent + "-old"); await symlink(parent + "-old", parent); }
  await expect(createInheritedCommandDirectory(path, trust, 0o2700, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
it.each(["directory", "symlink"])("never changes or deletes an existing leaf: %s", async kind => {
  const { root, path, trust } = await fixture(), foreign = join(root, "foreign");
  await mkdir(foreign); await writeFile(join(foreign, "sentinel"), "retain");
  if (kind === "symlink") await symlink(foreign, path);
  else { await mkdir(path); await writeFile(join(path, "sentinel"), "retain"); }
  const before = await lstat(path);
  await expect(createInheritedCommandDirectory(path, trust, 0o2700, portableDirectoryChild)).rejects.toThrow("creator failed");
  expect((await lstat(path)).ino).toBe(before.ino);
  expect(await readFile(join(path, "sentinel"), "utf8")).toBe("retain");
});
it.each(["timeout", "output", "exit", "spawn"])("bounds failed real children and waits for their closure: %s", async fault => {
  const script = fault === "output" ? 'process.stdout.write("x".repeat(65536)); setInterval(()=>{},1000)' : fault === "exit" ? "process.exit(2)" : "setInterval(()=>{},1000)";
  const child = spawn(fault === "spawn" ? "/nonexistent-directory-creator" : process.execPath, ["-e", script], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
  await expect(waitForDirectoryChild(child, fault === "timeout" ? 100 : 2_000)).rejects.toThrow("directory creator");
  if (fault === "timeout" || fault === "output") expect(child.signalCode).toBe("SIGKILL");
  if (fault === "exit") expect(child.exitCode).toBe(2);
});
it("bounds concurrent admission, releases the slot on failure and drains accepted work", async () => {
  const admit = createDirectoryCreatorAdmission(2, 1_000);
  let release!: () => void, active = 0, maximum = 0;
  const first = admit(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => { release = resolve; }); active--; throw new Error("child failed");
  });
  const firstResult = expect(first).rejects.toThrow("child failed");
  const second = admit(async () => { maximum = Math.max(maximum, ++active); active--; return "next"; });
  await expect(admit(async () => "overflow")).rejects.toThrow("capacity");
  release(); await firstResult; expect(await second).toBe("next"); expect(maximum).toBe(1);
  expect(await admit(async () => "reused")).toBe("reused");
});
it("expires queued work without executing it or leaking a slot", async () => {
  const admit = createDirectoryCreatorAdmission(2, 20); let release!: () => void;
  const first = admit(() => new Promise<void>(resolve => { release = resolve; })), expired = vi.fn(async () => {});
  await expect(admit(expired)).rejects.toThrow("queue expired"); expect(expired).not.toHaveBeenCalled();
  const next = admit(async () => "accepted"); release(); await first;
  expect(await next).toBe("accepted");
});

it.each(["other", "-p", "a".repeat(33), "../command"])("refuses an unfixed leaf before any child: %s", async leaf => {
  const { parent, trust } = await fixture(), run = vi.fn(portableDirectoryChild);
  await expect(createInheritedCommandDirectory(`${parent}/${leaf}`, trust, 0o2700, run)).rejects.toThrow("Unsafe command directory leaf");
  expect(run).not.toHaveBeenCalled();
});
