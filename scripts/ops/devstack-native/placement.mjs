import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { assert, noSymlinkAncestors } from "./control.mjs";

function protectedDirectory(entry) {
  // Mutable CLI requires uid0. Using the caller's identity also permits real
  // filesystem tests without treating synthetic metadata as root acceptance.
  return entry.isDirectory() && !entry.isSymbolicLink()
    && (entry.uid === 0 || entry.uid === process.getuid()) && (entry.mode & 0o022) === 0;
}
export async function inspectPlacement(path) {
  assert(resolve(path) === path, "placement_path_invalid");
  const parts = path.split("/").filter(Boolean); const missing = []; let current = ""; let absent = false;
  for (const part of parts) {
    current += `/${part}`;
    if (absent) { missing.push(current); continue; }
    let entry;
    try { entry = await lstat(current); } catch (error) {
      if (error.code !== "ENOENT") throw error; absent = true; missing.push(current); continue;
    }
    assert(protectedDirectory(entry), "placement_ancestry_unprotected");
  }
  return missing;
}
export async function preparePlacement(config, { readOnly = false } = {}) {
  const roots = [dirname(config.runtimeDirectory), config.runtimeDirectory, config.commandSocketRoot, config.stateRoot];
  // Validate both trees completely before creating even the first directory.
  const inspections = [];
  for (const path of roots) inspections.push(await inspectPlacement(path));
  const created = [];
  if (!readOnly) for (const missing of inspections) for (const path of missing) {
    if (created.some(item => item.path === path)) continue;
    await inspectPlacement(dirname(path));
    await mkdir(path, { mode: path === dirname(dirname(config.runtimeDirectory)) ? 0o755 : 0o700 });
    const entry = await lstat(path); assert(protectedDirectory(entry), "placement_create_unprotected");
    created.push({ path, inode: entry.ino, device: entry.dev });
  }
  return { state: readOnly ? "checked" : "prepared", created };
}
export async function exclusiveDirectory(path) {
  await noSymlinkAncestors(dirname(path));
  const entry = await lstat(path);
  assert(entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid(), "publication_directory_foreign");
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const owned = await handle.stat();
  assert(owned.ino === entry.ino && owned.dev === entry.dev, "publication_directory_replaced");
  await handle.chmod(0o700);
  const verify = async () => {
    const current = await lstat(path); const pinned = await handle.stat();
    assert(current.ino === pinned.ino && current.dev === pinned.dev && current.uid === process.getuid()
      && (current.mode & 0o7777) === 0o700, "publication_directory_not_exclusive");
  };
  await verify();
  return { verify, close: () => handle.close(), evidence: { path, inode: owned.ino, device: owned.dev, mode: "0700", lane: "root_only_native_fixture" } };
}
