import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assert } from "./control.mjs";
import { lookupIpcIdentity } from "./credential-evidence.mjs";
import { inspectPlacement } from "./placement.mjs";
export const anchorMetadata = entry => ({ device: String(entry.dev), inode: String(entry.ino), uid: entry.uid, gid: entry.gid,
  mode: (entry.mode & 0o7777).toString(8).padStart(4, "0") });
export async function runtimeAnchorStat(path, mode, identity) {
  assert(!(await inspectPlacement(dirname(path))).length, "runtime_anchor_ancestry_missing");
  const entry = await lstat(path);
  assert(entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === (identity.fixtureUid ?? 0)
    && entry.gid === identity.trustedGroup.gid && (entry.mode & 0o7777) === mode, "runtime_anchor_invalid");
  return entry;
}
export async function inspectRuntimeAnchors(config, identity) {
  identity ??= await lookupIpcIdentity();
  const anchors = { state: [config.stateRoot, 0o2700], runtimes: [join(config.stateRoot, "runtimes"), 0o2700],
    ipc: [config.runtimeDirectory, 0o2770], commands: [config.commandSocketRoot, 0o2770] };
  const result = {};
  for (const [role, [path, mode]] of Object.entries(anchors)) result[role] = anchorMetadata(await runtimeAnchorStat(path, mode, identity));
  return result;
}
