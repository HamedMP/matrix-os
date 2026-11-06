import { spawn, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assertCommandDirectory, type CommandDirectoryTrust } from "./command-ipc-policy.js";
import { createDirectoryCreatorAdmission } from "./directory-creator-admission.js";
import { assertNamespaceDirectory, HOST_NAMESPACE_TRUST } from "./namespace-ancestry.js";

const admit = createDirectoryCreatorAdmission();
export const DIRECTORY_CHILD_TIMEOUT_MS = 3_000;
export const DIRECTORY_CHILD_OUTPUT_LIMIT = 1_024;

// GNU mkdir -m0733 uses its own process mask and inherits setgid without an
// explicit setgid syscall. This one fixed host utility has no fallback backend.
const DIRECTORY_CREATOR = "/usr/bin/mkdir";

export interface DirectoryChildRequest {
  readonly parentFd: number;
  readonly parentPath: string;
  readonly leaf: string;
  readonly parent: Stats;
}
export type DirectoryChildRunner = (request: DirectoryChildRequest) => Promise<void>;
export function directoryChildArgs(request: DirectoryChildRequest, alias: string): string[] {
  return ["-m", "0733", "--", `${alias}/${request.leaf}`];
}

/** Internal process boundary, exported to exercise real failed-child limits. */
export function waitForDirectoryChild(child: ChildProcess, timeoutMs = DIRECTORY_CHILD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined, bytes = 0;
    const fail = () => { failure ??= new Error("Scope runtime directory creator failed"); child.kill("SIGKILL"); };
    const timeout = setTimeout(fail, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      // The fixed creator has no success output. Discard all content.
      if (bytes > DIRECTORY_CHILD_OUTPUT_LIMIT) fail();
    });
    child.once("error", () => { failure ??= new Error("Scope runtime directory creator unavailable"); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure || code !== 0 || signal || bytes !== 0) reject(failure ?? new Error("Scope runtime directory creator failed"));
      else resolve();
    });
  });
}

const runDirectoryChild: DirectoryChildRunner = async request => {
  if (process.platform !== "linux") throw new Error("Scope runtime directory creator requires Linux");
  if (process.getuid!() !== request.parent.uid || process.getgid!() !== request.parent.gid) throw new Error("Unsafe directory creator identity");
  await assertNamespaceDirectory(dirname(DIRECTORY_CREATOR), HOST_NAMESPACE_TRUST);
  const executable = await open(DIRECTORY_CREATOR, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await executable.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o6022) !== 0
      || (before.mode & 0o005) !== 0o005) throw new Error("Unsafe directory creator executable");
    // Descriptor4 binds exec to the verified utility; fd3 binds its one mkdir.
    const child = spawn("/proc/self/fd/4", directoryChildArgs(request, "/proc/self/fd/3"), {
      env: {}, cwd: "/", shell: false, stdio: ["ignore", "pipe", "pipe", request.parentFd, executable.fd],
    });
    await waitForDirectoryChild(child);
    const after = await lstat(DIRECTORY_CREATOR);
    if (!sameDirectoryIdentity(before, after)) throw new Error("Directory creator executable changed");
  } finally { await executable.close(); }
};

export function sameDirectoryIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
}
export function assertInheritedDirectory(entry: Stats, trust: CommandDirectoryTrust, mode: number): void {
  if (!entry.isDirectory() || entry.uid !== trust.uid || entry.gid !== trust.gid || (entry.mode & 0o7777) !== mode) {
    throw new Error("Unsafe inherited runtime directory");
  }
}

/** Callers first validate the complete protected ancestry and exact anchor role.
 * On uncertainty leave an owned orphan for quiesced cleanup; never delete a
 * pathname that may be a preexisting or substituted object.
 */
export async function createInheritedCommandDirectory(path: string,
  trust: CommandDirectoryTrust, parentMode: 0o2700 | 0o2770, runChild: DirectoryChildRunner = runDirectoryChild): Promise<void> {
  const leaf = basename(path), parentPath = dirname(path);
  if (!isAbsolute(path) || path.includes("\0") || !/^(command|[a-f0-9]{32})$/.test(leaf) || join(parentPath, leaf) !== path) throw new Error("Unsafe command directory leaf");
  await admit(async () => {
    const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const before = await parent.stat();
      assertInheritedDirectory(before, trust, parentMode);
      if (!sameDirectoryIdentity(before, await lstat(parentPath))) throw new Error("Runtime directory parent changed");
      await runChild({ parentFd: parent.fd, parentPath, leaf, parent: before });
      if (!sameDirectoryIdentity(before, await parent.stat()) || !sameDirectoryIdentity(before, await lstat(parentPath))) {
        throw new Error("Runtime directory parent changed");
      }
      assertCommandDirectory(await lstat(path), trust);
    } finally { await parent.close(); }
  });
}
