import { lookupIpcIdentity } from "./credential-evidence.mjs";
import { runtimeAnchorStat } from "./runtime-anchor-evidence.mjs";
import { constants } from "node:fs";
import { lstat, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assert, stat as lstatIfPresent } from "./control.mjs";
import { inspectPlacement } from "./placement.mjs";

export const STDERR_LIMIT = 65536;
export function stderrPath(config, token) {
  assert(/^matrix-native-[a-z0-9-]{1,64}$/.test(token), "stderr_token_invalid");
  return join(dirname(config.appRoot), `.${token}.stderr`);
}
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function protectedParent(path) {
  assert(!(await inspectPlacement(path)).length, "evidence_parent_missing");
  return lstat(path, { bigint: true });
}

// Create outside the three reserved leaves; they must stay empty until submission.
export async function createStderrCapture(path, fd2 = pid => stat(`/proc/${pid}/fd/2`, { bigint: true }), check = () => {}) {
  const parent = await protectedParent(dirname(path));
  check();
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600);
  const owned = await file.stat({ bigint: true });
  async function verify() {
    assert(sameObject(parent, await protectedParent(dirname(path))), "stderr_parent_changed");
    const actual = await lstat(path, { bigint: true });
    assert(sameObject(actual, owned) && actual.isFile() && actual.nlink === 1n && actual.uid === BigInt(process.getuid())
      && (actual.mode & 0o7777n) === 0o600n, "stderr_identity_unproven");
    return actual;
  }
  async function snapshot() {
    const entry = await verify();
    // A full file may have lost a partial (or entire) final warning to RLIMIT_FSIZE.
    assert(entry.size < BigInt(STDERR_LIMIT), "stderr_capture_full");
    const buffer = Buffer.alloc(Number(entry.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await verify();
    assert(bytesRead === buffer.length && after.size === entry.size && after.ctimeNs === entry.ctimeNs
      && (!bytesRead || buffer[bytesRead - 1] === 10), "stderr_capture_incomplete");
    return buffer;
  }
  return {
    async begin(supervisor) {
      assert(supervisor.StandardError === "append" && supervisor.LimitFSIZE === String(STDERR_LIMIT)
        && supervisor.LimitFSIZESoft === String(STDERR_LIMIT), "stderr_settings_unproven");
      assert(/^[1-9][0-9]*$/.test(supervisor.MainPID) && sameObject(owned, await fd2(supervisor.MainPID)), "stderr_fd_unproven");
      const before = await snapshot();
      return async () => {
        const after = await snapshot();
        assert(after.subarray(0, before.length).equals(before), "stderr_capture_changed");
        const interval = after.subarray(before.length);
        assert(!interval.includes("[scope-runtime] shutdown stop failed:"), "controller_shutdown_stop_failed");
        return { invocationId: supervisor.InvocationID, pid: Number(supervisor.MainPID), device: String(owned.dev), inode: String(owned.ino),
          standardError: "append", limitBytes: STDERR_LIMIT, startOffset: before.length, endOffset: after.length, shutdownStopFailure: false };
      };
    },
    async close() { try { await verify(); await unlink(path); } finally { await file.close(); } },
  };
}

// Observe both trees that the real launcher removes, before and after close.
// A missing or replaced parent must not make all descendant probes appear absent.
export async function beginCloseEvidence(config, capture, supervisor, handles, fixtureIdentity) {
  assert(capture && handles.length > 0 && handles.length <= 32, "close_evidence_required");
  const stderr = await capture.begin(supervisor);
  const parents = [join(config.stateRoot, "runtimes"), config.commandSocketRoot];
  const identity = fixtureIdentity ?? await lookupIpcIdentity();
  const observe = (path, index) => runtimeAnchorStat(path, index === 0 ? 0o2700 : 0o2770, identity);
  const roots = await Promise.all(parents.map(observe));
  for (const handle of handles) {
    assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid");
    for (const parent of parents) {
      const dir = await lstat(join(parent, handle.slice(8)));
      assert(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid(), "worker_teardown_before_unproven");
    }
  }
  return async () => {
    const evidence = await stderr();
    for (const [index, parent] of parents.entries()) {
      assert(sameObject(roots[index], await observe(parent, index)), "worker_teardown_parent_changed");
      for (const handle of handles) assert(!await lstatIfPresent(join(parent, handle.slice(8))), "worker_teardown_incomplete");
    }
    return { stderr: evidence, workers: handles.map(handle => ({ handle, runtimeDirectoryRemoved: true, commandDirectoryRemoved: true })) };
  };
}
