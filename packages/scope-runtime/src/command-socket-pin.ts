import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { assertCommandDirectory, assertCommandSocket, type CommandSocketTrust } from "./command-ipc-policy.js";

export interface PinnedCommandSocket { readonly path: string; close(): Promise<void> }
export type CommandSocketPinner = (path: string, trust: CommandSocketTrust) => Promise<PinnedCommandSocket>;
export interface CommandSocketInodes extends PinnedCommandSocket {
  parentStat(): Promise<Stats>;
  socketStat(): Promise<Stats>;
}
export type CommandSocketInodePinner = (path: string) => Promise<CommandSocketInodes>;
const LINUX_O_PATH = 0x200000;

/** Pin every ancestor and the socket without following worker-controlled links. */
export const pinCommandSocketInodes: CommandSocketInodePinner = async (path) => {
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
    const pinned = leaf, directory = parent;
    leaf = undefined;
    parent = undefined;
    let closing: Promise<void> | undefined;
    return { path: `/proc/self/fd/${pinned.fd}`, parentStat: () => directory.stat(), socketStat: () => pinned.stat(),
      close() { return closing ??= (async () => { try { await pinned.close(); } finally { await directory.close(); } })(); } };
  } finally {
    try { await leaf?.close(); } finally { await parent?.close(); }
  }
};

/** Trust comes from host launch identity, never from these filesystem objects. */
export const pinScopeRuntimeCommandSocket: CommandSocketPinner = async (path, trust) => {
  const pinned = await pinCommandSocketInodes(path);
  try {
    assertCommandDirectory(await pinned.parentStat(), trust);
    assertCommandSocket(await pinned.socketStat(), trust);
    return pinned;
  } catch (error: unknown) {
    await pinned.close();
    throw error;
  }
};
