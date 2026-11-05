import { verifyCompiledRuntime } from "./compiled.mjs";
import { open, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { assert, must, noSymlinkAncestors } from "./control.mjs";
import { show } from "./baseline.mjs";
import { assertRootIdentity, validateWorkerProperties, validateSupervisorProperties, WORKER_SECURITY_KEYS, SUPERVISOR_SECURITY_KEYS } from "./security.mjs";
import { DENIAL_PROBE, validateDenials } from "./controls.mjs";
export { show, hostSnapshot } from "./baseline.mjs";
// A procfs executable is a magic link. Pin its open file description while
// collecting identity and digest so a rapidly exiting PID cannot mix evidence.
export async function executableEvidence(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const entry = await file.stat({ bigint: true });
    assert(entry.isFile() && entry.size > 0n && entry.size <= 512n * 1024n * 1024n, "node_executable_invalid");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false, end: Number(entry.size) - 1 })) digest.update(chunk);
    const after = await file.stat({ bigint: true });
    assert(entry.ctimeNs === after.ctimeNs, "node_executable_changed");
    return { device: String(entry.dev), inode: String(entry.ino), sha256: digest.digest("hex") };
  } finally { await file.close(); }
}
export async function verifyExecutableEvidence(path, expected) {
  const actual = await executableEvidence(path);
  assert(actual.device === expected.device && actual.inode === expected.inode && actual.sha256 === expected.sha256, "node_executable_mismatch");
  return actual;
}

export async function buildFacts(config, dependencies, compiled, check) {
  assert(dependencies?.lockfileSha256 && compiled, "dependency_and_compiled_verification_required");
  const inventory = await verifyCompiledRuntime(config.appRoot, compiled);
  const { root, binary, workerRoot, workerBinary } = config.ownedNode;
  await noSymlinkAncestors(binary, true);
  const source = await executableEvidence(binary);
  check();
  const nodeVersion = await must(binary, ["--version"], "node_version_failed");
  const nativeExecutable = `${dependencies.native.root}/claude`;
  check();
  const nativeVersion = await must(nativeExecutable, ["--version"], "native_version_failed");
  assert(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion) && Number(nodeVersion.slice(1).split(".")[0]) >= 24, "node_version_invalid");
  const nativeMatch = /^([0-9]+\.[0-9]+\.[0-9]+)(?: \(Claude Code\))?$/.exec(nativeVersion);
  assert(nativeMatch && nativeMatch[1] === dependencies.sdk.claudeCodeVersion, "native_version_invalid");
  await verifyExecutableEvidence(binary, source);
  return { node: { path: binary, version: nodeVersion, ...source, mount: { source: root, destination: workerRoot, readOnly: true }, workerBinary },
    sdk: { path: dependencies.sdk.root, version: dependencies.sdk.version, sha256: dependencies.sdk.installed.members["sdk.mjs"] },
    native: { path: nativeExecutable, version: nativeVersion, sha256: dependencies.native.installed.members.claude }, hashes: inventory.files };
}
export async function inspectSupervisor(config, node) {
  const result = validateSupervisorProperties(await show(config.supervisorUnit, SUPERVISOR_SECURITY_KEYS), config);
  const pid = Number(result.properties.MainPID);
  assert(Number.isSafeInteger(pid) && pid > 1, "supervisor_pid_invalid");
  return { ...result, node: await verifyExecutableEvidence(`/proc/${pid}/exe`, node) };
}
export async function inspectWorkerConfiguration(config, handle, dependencies, unit, node) {
  const properties = validateWorkerProperties(await show(unit, WORKER_SECURITY_KEYS), config, handle, dependencies);
  const pid = Number(properties.MainPID); assert(Number.isInteger(pid) && pid > 1, "worker_pid_invalid");
  const status = await readFile(`/proc/${pid}/status`, "utf8"); const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]), gid = Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]);
  assert(uid >= 61184 && uid <= 65519 && Number.isInteger(gid), "worker_identity_invalid");
  let actualRoot, expectedRoot, rootIdentity;
  try {
    actualRoot = await open(`/proc/${pid}/root`, constants.O_RDONLY | constants.O_DIRECTORY);
    expectedRoot = await open(properties.RootDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    rootIdentity = assertRootIdentity(await actualRoot.stat({ bigint: true }), await expectedRoot.stat({ bigint: true }));
  } finally { try { await actualRoot?.close(); } finally { await expectedRoot?.close(); } }
  const namespaces = {};
  for (const name of ["mnt", "net"]) {
    namespaces[name] = await readlink(`/proc/${pid}/ns/${name}`);
    assert(namespaces[name] !== await readlink(`/proc/self/ns/${name}`), "worker_namespace_not_isolated");
  }
  const cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
  assert(cgroup === `0::${properties.ControlGroup}` && properties.ControlGroup.endsWith(`/${unit}`), "worker_cgroup_mismatch");
  return { properties, rootIdentity, uid, gid, namespaces, cgroup,
    workerBinary: config.ownedNode.workerBinary, node: await verifyExecutableEvidence(`/proc/${pid}/exe`, node) };
}
export async function inspectWorker(configuration, controls) {
  const { uid, gid, properties } = configuration, pid = Number(properties.MainPID);
  const input = JSON.stringify({ targets: controls.targets, filePath: controls.filePath, port: controls.port });
  const result = JSON.parse(await must("/usr/bin/nsenter", [`--target=${pid}`, "--mount", "--net", "--root", "--wd", `--setuid=${uid}`, `--setgid=${gid}`, "--", configuration.workerBinary, "--input-type=module", "-e", DENIAL_PROBE, input], "worker_denial_probe_failed", 20_000));
  return { ...configuration, hostPositive: controls.hostPositive, workerControls: validateDenials(result, controls) };
}

export async function inspectWorkerPair(ledger, handles, inspect) {
  assert(handles.length === 2 && handles[0] !== handles[1], "worker_pair_handles_invalid");
  const observe = async () => Promise.all(handles.map(async handle => {
    const state = await ledger.freshWorker(handle);
    assert(state.ActiveState === "active" && state.SubState === "running", "worker_pair_not_live");
    return state;
  }));
  const before = await observe(), pair = await Promise.all(handles.map(inspect)), after = await observe();
  for (const [i, worker] of pair.entries()) {
    assert(before[i].MainPID === worker.properties.MainPID && before[i].MainPID === after[i].MainPID
      && before[i].InvocationID === after[i].InvocationID, "worker_pair_incarnation_changed");
  }
  const [first, peer] = pair;
  for (const name of ["net", "mnt"]) assert(first.namespaces[name] !== peer.namespaces[name], "worker_pair_namespace_shared");
  assert(first.cgroup !== peer.cgroup, "worker_pair_cgroup_shared");
  assert(first.rootIdentity.device !== peer.rootIdentity.device || first.rootIdentity.inode !== peer.rootIdentity.inode, "worker_pair_root_shared");
  return pair.map((worker, i) => ({ ...worker, handle: handles[i], invocationId: before[i].InvocationID }));
}
