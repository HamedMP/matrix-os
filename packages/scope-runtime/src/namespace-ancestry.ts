import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Deployment trusts the host root only. Native test fixtures can supply an owned private anchor. */
export interface NamespacePathTrust { readonly root: string; readonly uid: number; readonly ipcGid?: number }
export const HOST_NAMESPACE_TRUST: NamespacePathTrust = Object.freeze({ root: "/", uid: 0 });

// Only the systemd-declared IPC leaf is shared with Gateway's matrix group.
const exec = promisify(execFile);
let matrixGroup: Promise<number> | undefined;
function trustedIpcGroup(trust: NamespacePathTrust): Promise<number> {
  if (trust.ipcGid !== undefined) return Promise.resolve(trust.ipcGid);
  return matrixGroup ??= exec("/usr/bin/getent", ["group", "matrix"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 2000, maxBuffer: 4096,
  }).then(({ stdout }) => {
    const match = /^matrix:[^:\n]*:([0-9]{1,10}):[^:\n]*$/.exec(stdout.trim());
    if (!match) throw new Error("Unsafe namespace IPC group");
    return Number(match[1]);
  });
}

export async function assertNamespaceDirectory(path: string, trust: NamespacePathTrust, ipcLeaf = false): Promise<void> {
  const tail = relative(trust.root, path);
  if (resolve(path) !== path || tail === ".." || tail.startsWith("../")) throw new Error("Unsafe namespace directory placement");
  let current = trust.root;
  for (const segment of ["", ...tail.split("/").filter(Boolean)]) {
    current = join(current, segment);
    let dir;
    try { dir = await lstat(current); } catch (error) {
      // Only the trusted owner can create a missing child beneath this chain.
      if (segment && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!dir.isDirectory() || dir.uid !== trust.uid) throw new Error("Unsafe namespace directory");
    if ((dir.mode & 0o022) !== 0 && !(ipcLeaf && current === path && (dir.mode & 0o7777) === 0o770
      && dir.gid === await trustedIpcGroup(trust))) throw new Error("Unsafe namespace directory");
  }
}

export async function assertNamespaceSocket(path: string, trust: NamespacePathTrust): Promise<void> {
  await assertNamespaceDirectory(dirname(path), trust, true);
  try {
    if (!(await lstat(path)).isSocket()) throw new Error("Unsafe namespace socket");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export interface RuntimeDirectoryRoots { stateRoot: string; commandSocketRoot?: string; namespaceTrust?: NamespacePathTrust }

export async function assertRuntimeDirectoryPlacement(paths: RuntimeDirectoryRoots): Promise<void> {
  if (!paths.commandSocketRoot) return; // Unchanged legacy layout.
  const trust = paths.namespaceTrust ?? HOST_NAMESPACE_TRUST;
  await assertNamespaceDirectory(join(paths.stateRoot, "runtimes"), trust);
  await assertNamespaceDirectory(paths.commandSocketRoot, trust, true);
}
