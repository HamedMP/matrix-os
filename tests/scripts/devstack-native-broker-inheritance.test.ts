import { chmod, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inheritedBrokerPublication } from "../../scripts/ops/devstack-native/broker-publication.mjs";
import { removePublishedSocket } from "../../scripts/ops/devstack-native/proof.mjs";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await createUnixSocketTempDir(); roots.push(root); commandIdentityFixture(root);
  const outer = join(root, "namespace"), inner = join(outer, "ipc");
  await mkdir(inner, { recursive: true }); await chmod(outer, 0o700); await chmod(inner, 0o2770);
  return { root, outer, inner, trust: { root, uid: process.getuid!(), gid: (await lstat(inner)).gid } };
}
it("preserves PID1 anchor2770 behind the pinned private ancestor during publication and cleanup", async () => {
  const { outer, inner, trust } = await fixture(), guard = await inheritedBrokerPublication(inner, outer, () => {}, trust);
  try {
    await guard.verify(); expect((await lstat(inner)).mode & 0o7777).toBe(0o2770);
    const path = join(inner, "broker.sock"); await writeFile(path, "owned"); const owned = await lstat(path);
    await removePublishedSocket(path, owned, guard);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(outer)).mode & 0o7777).toBe(0o700);
    expect((await lstat(inner)).mode & 0o7777).toBe(0o2770);
  } finally { await guard.close(); await guard.close(); }
});
it.each(["ancestor_mode", "outer_mode", "inner_mode", "outer_identity", "inner_identity"])("refuses publication/unlink after the two-directory proof changes: %s", async fault => {
  const { root, outer, inner, trust } = await fixture(), guard = await inheritedBrokerPublication(inner, outer, () => {}, trust);
  const path = join(inner, "broker.sock"); await writeFile(path, "original"); const owned = await lstat(path);
  try {
    if (fault === "ancestor_mode") await chmod(root, 0o770);
    if (fault === "outer_mode") await chmod(outer, 0o770);
    if (fault === "inner_mode") await chmod(inner, 0o770);
    if (fault === "outer_identity") {
      await rename(outer, outer + "-old"); await mkdir(inner, { recursive: true });
      await chmod(outer, 0o700); await chmod(inner, 0o2770); await writeFile(path, "replacement");
    }
    if (fault === "inner_identity") {
      await rename(inner, inner + "-old"); await mkdir(inner); await chmod(inner, 0o2770); await writeFile(path, "replacement");
    }
    await expect(guard.verify()).rejects.toThrow();
    await expect(removePublishedSocket(path, owned, guard)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(fault.endsWith("identity") ? "replacement" : "original");
  } finally { await guard.close(); }
});
it.each(["mode", "gid", "uid", "relationship", "symlink"])("does not grant a fence for invalid declared placement: %s", async fault => {
  const { outer, inner, trust } = await fixture(); let parent = outer;
  if (fault === "mode") await chmod(inner, 0o770);
  if (fault === "gid") trust.gid++;
  if (fault === "uid") trust.uid++;
  if (fault === "relationship") parent = trust.root;
  if (fault === "symlink") { await rename(inner, inner + "-old"); await symlink(inner + "-old", inner); }
  await expect(inheritedBrokerPublication(inner, parent, () => {}, trust)).rejects.toThrow();
});
