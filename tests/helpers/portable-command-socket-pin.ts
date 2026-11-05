import { link, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { createUnixSocketTempDir } from "./unix-socket-temp.js";

/** Explicit portable fixture adapter. Production never selects this pathname-alias implementation. */
export async function portableCommandSocketPin(path: string) {
  const original = await lstat(path);
  if (!original.isSocket() || original.isSymbolicLink()) throw new Error("Unsafe scope runtime command socket");
  const root = await createUnixSocketTempDir();
  const alias = join(root, "worker.sock");
  try {
    await link(path, alias);
    const pinned = await lstat(alias);
    if (!pinned.isSocket() || pinned.ino !== original.ino || pinned.dev !== original.dev) {
      throw new Error("Unsafe portable command socket alias");
    }
    return { path: alias, async close() { await rm(root, { recursive: true, force: true }); } };
  } catch (error: unknown) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
