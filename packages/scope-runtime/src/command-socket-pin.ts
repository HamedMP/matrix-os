import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

export interface PinnedCommandSocket {
  readonly path: string;
  close(): Promise<void>;
}
export type CommandSocketPinner = (path: string) => Promise<PinnedCommandSocket>;
// Linux UAPI O_PATH (x64 and arm64). Node accepts raw numeric open flags.
const LINUX_O_PATH = 0x200000;

/** Pin every parent and the socket inode; never reconnect through a worker-writable pathname. */
export const pinScopeRuntimeCommandSocket: CommandSocketPinner = async (path) => {
  if (process.platform !== "linux") throw new Error("Scope runtime command socket pinning requires Linux");
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Unsafe scope runtime command socket path");
  }
  const directoryFlags = LINUX_O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY;
  let parent: FileHandle | undefined;
  let leaf: FileHandle | undefined;
  try {
    parent = await open("/", directoryFlags);
    for (const segment of dirname(path).split("/").filter(Boolean)) {
      const next = await open(`/proc/self/fd/${parent.fd}/${segment}`, directoryFlags);
      const previous = parent;
      parent = next;
      await previous.close();
      if (!(await parent.stat()).isDirectory()) throw new Error("Unsafe scope runtime command directory");
    }
    leaf = await open(`/proc/self/fd/${parent.fd}/${basename(path)}`, LINUX_O_PATH | constants.O_NOFOLLOW);
    const entry = await leaf.stat();
    if (!entry.isSocket() || entry.isSymbolicLink() || entry.nlink > 1) throw new Error("Unsafe scope runtime command socket");
    await parent.close();
    parent = undefined;
    const pinned = leaf;
    leaf = undefined;
    let closing: Promise<void> | undefined;
    return { path: `/proc/self/fd/${pinned.fd}`, close() { return closing ??= pinned.close(); } };
  } finally {
    try { await leaf?.close(); } finally { await parent?.close(); }
  }
};
