import { lookupIpcIdentity } from "./credential-evidence.mjs";
import { runtimeAnchorStat, anchorMetadata } from "./runtime-anchor-evidence.mjs";
import { lstat, opendir } from "node:fs/promises";
import { show } from "./baseline.mjs";
import { assert, noSymlinkAncestors, stat } from "./control.mjs";
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
const metadata = entry => ({ device: String(entry.dev), inode: String(entry.ino), uid: entry.uid, gid: entry.gid,
  mode: (entry.mode & 0o7777).toString(8).padStart(4, "0"), links: entry.nlink });
async function names(path, max) {
  const entries = [];
  for await (const entry of await opendir(path)) { assert(entries.length < max, "command_evidence_capacity"); entries.push(entry.name); }
  return entries.sort();
}
// Observation only: no chmod/chgrp, connections or workload instrumentation.
export async function inspectCommandIpc(config, handle, identity) {
  assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid");
  const privateRoot = await runtimeAnchorStat(`${config.stateRoot}/runtimes/${handle.slice(8)}`, 0o2700, identity);
  const parentPath = `${config.commandSocketRoot}/${handle.slice(8)}`;
  await noSymlinkAncestors(parentPath);
  const parent = await lstat(parentPath), entries = await names(parentPath, 3);
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && parent.gid === identity.trustedGroup.gid
    && (parent.mode & 0o7777) === 0o2733, "command_parent_evidence_invalid");
  const stage = entries.find(name => /^\.w-[A-Za-z0-9]{6}$/.test(name));
  assert(entries.length === 2 && stage && entries.includes("worker.sock"), "command_staging_evidence_invalid");
  const socketPath = `${parentPath}/worker.sock`, stagingPath = `${parentPath}/${stage}`;
  const socket = await lstat(socketPath), staging = await lstat(stagingPath);
  assert(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === identity.workload.uid && socket.gid === identity.trustedGroup.gid
    && (socket.mode & 0o7777) === 0o620 && socket.nlink === 1, "command_socket_evidence_invalid");
  assert(staging.isDirectory() && !staging.isSymbolicLink() && staging.uid === identity.workload.uid && staging.gid === identity.trustedGroup.gid
    && (staging.mode & 0o7777) === 0o2700, "command_staging_evidence_invalid");
  assert((await names(stagingPath, 1)).length === 0, "command_staging_not_empty");
  assert(same(parent, await lstat(parentPath)) && same(socket, await lstat(socketPath)) && same(staging, await lstat(stagingPath))
    && JSON.stringify(entries) === JSON.stringify(await names(parentPath, 3)), "command_publication_changed");
  return { trustedGroup: identity.trustedGroup, privateRoot: anchorMetadata(privateRoot), parent: metadata(parent), socket: metadata(socket),
    staging: { ...metadata(staging), name: stage, empty: true, bindNameAbsent: true, retainedUntilQuiescence: true }, hostConnections: 0 };
}
// The production supervisor removes these after its exact-unit/cgroup fence.
// A successful observed absence closes the later cap0 cleanup gate only when
// paired with pre-stop staging evidence and re-attested live supervisor credentials.
export async function inspectCommandCleanup(config, handles) {
  assert(handles.length > 0 && handles.length <= 32 && new Set(handles).size === handles.length, "command_cleanup_handles_invalid");
  const parents = [config.commandSocketRoot, `${config.stateRoot}/runtimes`];
  const identity = await lookupIpcIdentity(), before = [];
  for (const [index, path] of parents.entries()) {
    before.push(await runtimeAnchorStat(path, index === 0 ? 0o2770 : 0o2700, identity));
  }
  const units = [];
  for (const handle of handles) {
    assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid");
    const unit = `${config.workerUnitPrefix}${handle.slice(8)}.service`;
    const terminal = await show(unit, ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "ControlGroup", "RootDirectory"]);
    assert(terminal.Id === unit && terminal.MainPID === "0" && terminal.ControlPID === "0" && terminal.ControlGroup === ""
      && ((terminal.LoadState === "not-found" && terminal.ActiveState === "inactive" && terminal.SubState === "dead" && terminal.RootDirectory === "")
        || (terminal.LoadState === "loaded" && ["inactive", "failed"].includes(terminal.ActiveState) && ["dead", "failed"].includes(terminal.SubState)
          && terminal.RootDirectory === `${config.stateRoot}/runtimes/${handle.slice(8)}/root`)), "command_cleanup_unit_not_quiesced");
    units.push({ unit, ...terminal });
    for (const parent of parents) assert(!await stat(`${parent}/${handle.slice(8)}`), "command_cleanup_incomplete");
  }
  for (const [index, path] of parents.entries()) assert(same(before[index],
    await runtimeAnchorStat(path, index === 0 ? 0o2770 : 0o2700, identity)), "command_cleanup_parent_changed");
  return { units, workers: handles.map(handle => ({ handle, retainedEmptyStagingRemoved: true, commandDirectoryRemoved: true, runtimeDirectoryRemoved: true })), actor: "source_supervisor_after_quiesced_unit_cgroup" };
}
