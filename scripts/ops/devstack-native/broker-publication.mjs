import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { assert } from "./control.mjs";
import { lookupIpcIdentity } from "./credential-evidence.mjs";
import { exclusiveDirectory } from "./placement.mjs";

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
// Explicit test trust is internal to owned filesystem fixtures, never CLI/env.
async function protectedAncestors(path, trust) {
  const tail = relative(trust.root, path);
  assert(resolve(path) === path && tail !== ".." && !tail.startsWith("../"), "broker_ancestor_invalid");
  let current = trust.root;
  for (const segment of ["", ...tail.split("/").filter(Boolean)]) {
    current = join(current, segment); const entry = await lstat(current);
    assert(entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === trust.uid && (entry.mode & 0o022) === 0, "broker_ancestor_unprotected");
  }
}

/** This fence is specific to a direct-child IPC anchor behind a root-only
 * namespace directory. Workers receive only socket/command bind mounts, never
 * either ancestor or its descriptor. Do not generalize it to writable ancestry.
 */
export async function inheritedBrokerPublication(path, bindingParent, check = () => {}, fixtureTrust) {
  const trust = fixtureTrust ?? { root: "/", uid: 0, gid: (await lookupIpcIdentity()).trustedGroup.gid };
  assert(dirname(path) === bindingParent && path !== bindingParent, "broker_publication_not_direct_child");
  await protectedAncestors(bindingParent, trust);
  const handles = [];
  try {
    for (const directory of [bindingParent, path]) handles.push(await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const [outer, inner] = await Promise.all(handles.map(handle => handle.stat()));
    const verify = async () => {
      check(); await protectedAncestors(bindingParent, trust);
      const entries = await Promise.all([lstat(bindingParent), lstat(path), ...handles.map(handle => handle.stat())]);
      assert(entries.every((entry, index) => entry.isDirectory() && !entry.isSymbolicLink()
        && same(entry, index % 2 === 0 ? outer : inner)), "broker_publication_directory_replaced");
      assert(outer.uid === trust.uid && (outer.mode & 0o7777) === 0o700
        && inner.uid === trust.uid && inner.gid === trust.gid && (inner.mode & 0o7777) === 0o2770, "broker_publication_directory_unprotected");
    };
    await verify(); let closing;
    return { verify, close() { return closing ??= Promise.all(handles.map(handle => handle.close())).then(() => undefined); },
      evidence: { mode: "2770", ancestorMode: "0700", lane: "root_only_namespace_ancestor", inode: inner.ino, device: inner.dev } };
  } catch (error) { await Promise.allSettled(handles.map(handle => handle.close())); throw error; }
}

export async function brokerPublicationDirectory(path, bindingParent, check) {
  // Production canonical namespace layout always takes the two-directory fence.
  // The older single-directory fixture retains its existing exclusive700 fence.
  if (dirname(path) === bindingParent || ((await lstat(path)).mode & 0o7777) === 0o2770) {
    return inheritedBrokerPublication(path, bindingParent, check);
  }
  return exclusiveDirectory(path, check);
}
