// Linux /proc/<pid>/exe is a magic link to the running executable. Observe
// metadata and bytes from one open file description throughout each reading.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { assert } from "./control.mjs";
import { DENIAL_PROBE } from "./controls.mjs";

const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;
async function evidence(file) {
  const entry = await file.stat({ bigint: true });
  assert(entry.isFile() && entry.size > 0n && entry.size <= 512n * 1024n * 1024n, "node_executable_invalid");
  const digest = createHash("sha256");
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: Number(entry.size) - 1 })) digest.update(chunk);
  const after = await file.stat({ bigint: true });
  assert(entry.ctimeNs === after.ctimeNs, "node_executable_changed");
  return { device: String(entry.dev), inode: String(entry.ino), sha256: digest.digest("hex") };
}
function requireMatch(actual, expected) {
  assert(actual.device === expected.device && actual.inode === expected.inode && actual.sha256 === expected.sha256, "node_executable_mismatch");
  return actual;
}
export async function executableEvidence(path) {
  const file = await open(path, READ_FLAGS);
  try { return await evidence(file); } finally { await file.close(); }
}
export async function verifyExecutableEvidence(path, expected) {
  return requireMatch(await executableEvidence(path), expected);
}
export async function attestRunningNode(host, running) {
  return verifyExecutableEvidence(host, await executableEvidence(running));
}
export async function withVerifiedWorkerNode({ host, running, guest }, expected, run) {
  const file = await open(guest, READ_FLAGS | constants.O_NOFOLLOW);
  try {
    const node = requireMatch(await evidence(file), expected);
    await verifyExecutableEvidence(host, expected);
    await verifyExecutableEvidence(running, expected);
    if (!run) return { node };
    const result = await run(file);
    // The probe executed the pinned object. Publish its results only while
    // both paths and the worker image still identify the reviewed artifact.
    await verifyExecutableEvidence(guest, expected);
    await verifyExecutableEvidence(host, expected);
    await verifyExecutableEvidence(running, expected);
    return { node, result };
  } finally { await file.close(); }
}

export function runPinnedDenialProbe(file, { pid, uid, gid }, input, spawnProcess = spawn) {
  // fd 3 is the only host descriptor granted to this namespaced process. It
  // points to the reviewed read-only executable, even across a rename.
  const args = [`--target=${pid}`, "--mount", "--net", "--root", "--wd", `--setuid=${uid}`, `--setgid=${gid}`,
    "--", "/proc/self/fd/3", "--input-type=module", "-e", DENIAL_PROBE, input];
  return new Promise((resolve, reject) => {
    const child = spawnProcess("/usr/bin/nsenter", args, { stdio: ["ignore", "pipe", "ignore", file.fd],
      env: { PATH: "/usr/bin:/bin", HOME: "/", LANG: "C" }, timeout: 20_000, killSignal: "SIGKILL" });
    const chunks = []; let bytes = 0;
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= 256 * 1024) chunks.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", error => reject(new Error("worker_denial_probe_failed", { cause: error })));
    child.once("close", code => {
      if (code === 0 && bytes <= 256 * 1024) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error("worker_denial_probe_failed"));
    });
  });
}
