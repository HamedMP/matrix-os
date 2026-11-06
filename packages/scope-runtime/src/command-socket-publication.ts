import { dirname, join } from "node:path";
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Server } from "node:net";
import { COMMAND_DIRECTORY_MODE, COMMAND_SOCKET_MODE, COMMAND_STAGING_MODE, assertCommandSocket } from "./command-ipc-policy.js";
import { pinCommandSocketInodes, type CommandSocketInodePinner } from "./command-socket-pin.js";

function sameInode(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev; }

/** Typed fixture seam; production always uses Linux O_PATH descriptors. */
export interface CommandPublicationDependencies {
  pin?: CommandSocketInodePinner;
  createStaging?: (prefix: string) => Promise<string>;
}

/** Publish only the pinned, worker-owned inode; never chmod a replacement pathname. */
export async function publishCommandSocket(path: string, expected: Stats, dependencies: CommandPublicationDependencies = {}) {
  const pinned = await (dependencies.pin ?? pinCommandSocketInodes)(path);
  try {
    const parent = await pinned.parentStat(), original = await pinned.socketStat();
    if (!parent.isDirectory() || (parent.mode & 0o7777) !== COMMAND_DIRECTORY_MODE
      || !sameInode(expected, original) || !original.isSocket() || original.nlink !== 1 || original.uid !== process.getuid?.() || original.gid !== parent.gid) {
      throw new Error("Unsafe worker command socket publication");
    }
    await chmod(pinned.path, COMMAND_SOCKET_MODE);
    const published = await pinned.socketStat();
    assertCommandSocket(published, { uid: parent.uid, gid: parent.gid, workloadUid: original.uid });
    if (!sameInode(original, published)) throw new Error("Unsafe worker command socket publication");
    const current = await lstat(path);
    if (!sameInode(original, current)) throw new Error("Replaced worker command socket");
  } finally { await pinned.close(); }
}

/**
 * libuv unlinks its bind pathname on close, including replacements. Bind privately,
 * then exclusively link the owned inode to the command name. The empty private
 * bind directory stays reserved until close; libuv never owns the command name.
 */
export async function listenCommandSocket(server: Server, path: string, dependencies: CommandPublicationDependencies = {}) {
  if (Buffer.byteLength(path) > 107) throw new Error("Command socket path exceeds capacity");
  const parent = await lstat(dirname(path));
  const staging = await (dependencies.createStaging ?? mkdtemp)(join(dirname(path), ".w-"));
  const stagingIdentity = await lstat(staging), bound = join(staging, "s");
  let original: Stats | undefined;
  let linked = false;
  async function cleanup(): Promise<void> {
    if (linked && original) {
      try {
        const entry = await lstat(path);
        if (sameInode(original, entry) && entry.isSocket()) await unlink(path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      if (sameInode(stagingIdentity, await lstat(staging))) await rmdir(staging);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    // Linux mkdir inherits setgid/GID. Clearing it here would lose the IPC group.
    if (!stagingIdentity.isDirectory() || stagingIdentity.uid !== process.getuid?.()
      || stagingIdentity.gid !== parent.gid || (stagingIdentity.mode & 0o7777) !== COMMAND_STAGING_MODE) {
      throw new Error("Unsafe worker command socket staging");
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(bound, resolve); });
    original = await lstat(bound);
    if (!original.isSocket() || original.nlink !== 1 || original.uid !== process.getuid?.()) {
      throw new Error("Unsafe worker command socket binding");
    }
    await link(bound, path); // EEXIST preserves every pre-existing final entry.
    linked = true;
    const published = await lstat(path), stillBound = await lstat(bound);
    if (!sameInode(original, published) || !sameInode(original, stillBound) || published.nlink !== 2) {
      throw new Error("Replaced worker command socket binding");
    }
    await unlink(bound);
    await publishCommandSocket(path, original, dependencies);
    return cleanup;
  } catch (error: unknown) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await cleanup();
    throw error;
  }
}
