/** Semantic authorization policy; shared by workers, host checks, and profile digests. */
export const COMMAND_DIRECTORY_MODE = 0o2733;
export const COMMAND_STAGING_MODE = 0o2700;
export const COMMAND_SOCKET_MODE = 0o620;
export const COMMAND_WORKLOAD_USER = "matrix-scope-workload";
export const COMMAND_IPC_GROUP = "matrix";
export const COMMAND_IPC_POLICY = Object.freeze([
  "CommandIPC=v2",
  "CommandAnchors=pid1-root:matrix/state-and-runtimes-02700/runtime-ipc-02770",
  "CommandPrivateRoot=inherited-02700/exclusive-no-chmod",
  "CommandDirectory=root:matrix/02733/exclusive-inherited-0733/child-local-umask0",
  "CommandCreator=pinned-parent-and-usr-bin-mkdir/sterile-m0733-single-mkdir/serial-bounded/verify-identity",
  "CommandStaging=worker:inherited-matrix/02700/exclusive-link/single-link-final",
  "CommandSocket=active-workload:inherited-matrix/0620/one-link",
  "CommandPublication=owner-pinned-fd-chmod-before-readiness",
  "CommandCleanup=quiesced-owned-unit-cgroup/trusted-parent/empty-staging-rmdir",
  "CommandDispatch=nofollow-ancestors-pinned-inode/trusted-parent-and-unit-uid",
]);

export interface CommandDirectoryTrust { readonly uid: number; readonly gid: number }
export interface CommandSocketTrust extends CommandDirectoryTrust { readonly workloadUid: number }

export function assertCommandDirectory(entry: { isDirectory(): boolean; uid: number; gid: number; mode: number }, trust: CommandDirectoryTrust): void {
  if (!entry.isDirectory() || entry.uid !== trust.uid || entry.gid !== trust.gid
    || (entry.mode & 0o7777) !== COMMAND_DIRECTORY_MODE) throw new Error("Unsafe scope runtime command directory");
}

export function assertCommandSocket(entry: { isSocket(): boolean; uid: number; gid: number; mode: number; nlink: number }, trust: CommandSocketTrust): void {
  if (!entry.isSocket() || entry.nlink !== 1 || entry.uid !== trust.workloadUid || entry.gid !== trust.gid
    || (entry.mode & 0o7777) !== COMMAND_SOCKET_MODE) throw new Error("Unsafe scope runtime command socket");
}
