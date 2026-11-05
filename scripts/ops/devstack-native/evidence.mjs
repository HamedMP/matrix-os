import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { assert, hash, must, NODE, noSymlinkAncestors, stat } from "./control.mjs";

const SERVICE_KEYS = ["LoadState", "ActiveState", "SubState", "InvocationID", "MainPID", "NRestarts"];
export async function show(unit, keys) {
  const output = await must("/usr/bin/systemctl", ["show", unit, ...keys.map(key => `--property=${key}`)], "unit_evidence_unavailable");
  const values = {};
  for (const line of output.split("\n")) {
    const index = line.indexOf("="); const key = line.slice(0, index);
    assert(keys.includes(key) && line.length <= 4096, "unit_evidence_invalid"); values[key] = line.slice(index + 1);
  }
  return values;
}
export async function hostSnapshot(config) {
  const output = await must("/usr/bin/systemctl", ["list-units", "--all", "--plain", "--no-legend", "matrix*.service"], "peer_inventory_unavailable");
  const units = output.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(Boolean).sort();
  assert(units.length <= 128 && units.every(name => /^matrix[a-zA-Z0-9_.@-]*\.service$/.test(name)), "peer_inventory_invalid");
  const services = {};
  for (const unit of units) {
    if (unit === config.supervisorUnit || unit.startsWith(config.workerUnitPrefix)) continue;
    services[unit] = await show(unit, SERVICE_KEYS);
  }
  for (const unit of ["matrix-gateway.service", "matrix-shell.service", "matrix-sync-agent.service", "matrix-scope-runtime.service"]) {
    services[unit] ??= await show(unit, SERVICE_KEYS);
  }
  const artifacts = {};
  for (const path of ["/opt/matrix/release.json", "/opt/matrix/app/BUNDLE_VERSION", "/opt/matrix/app/packages/scope-runtime/dist/main.js", "/opt/matrix/bin/matrix-scope-runtime", "/opt/matrix/app/packages/gateway/dist/main.js", "/opt/matrix/bin/matrix-gateway", "/opt/matrix/bin/matrix-shell", "/opt/matrix/bin/matrix-sync-agent"]) {
    const entry = await stat(path); artifacts[path] = entry?.isFile() ? { sha256: await hash(path), inode: entry.ino, device: entry.dev, size: entry.size } : null;
  }
  const sockets = {};
  const roots = ["/run/matrix-scope-runtime", "/run/matrix-scope"];
  const namespaces = await stat("/run/matrix-devstack");
  if (namespaces) {
    const entries = await readdir("/run/matrix-devstack", { withFileTypes: true }); assert(entries.length <= 64, "peer_socket_inventory_capacity");
    for (const entry of entries) if (entry.isDirectory() && entry.name !== config.namespace) roots.push(`/run/matrix-devstack/${entry.name}/scope-runtime`);
  }
  for (const root of roots) for (const name of ["broker.sock", "supervisor.sock"]) {
    const path = `${root}/${name}`; const entry = await stat(path);
    sockets[path] = entry ? { inode: entry.ino, device: entry.dev, mode: entry.mode, uid: entry.uid, gid: entry.gid } : null;
  }
  return { services, artifacts, sockets };
}
export async function buildFacts(config) {
  const root = config.appRoot;
  const sdk = await realpath(`${root}/node_modules/@anthropic-ai/claude-agent-sdk`);
  const native = await realpath(`${root}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64`);
  for (const path of [sdk, native, `${sdk}/sdk.mjs`, `${native}/claude`, `${root}/packages/scope-runtime/dist/main.js`,
    `${root}/packages/scope-runtime/dist/worker.js`, NODE]) await noSymlinkAncestors(path, true);
  const sdkManifest = JSON.parse(await readFile(`${sdk}/package.json`, "utf8"));
  const nativeManifest = JSON.parse(await readFile(`${native}/package.json`, "utf8"));
  assert(/^0\.[0-9]+\.[0-9]+$/.test(sdkManifest.version) && sdkManifest.version === nativeManifest.version, "sdk_version_invalid");
  const files = (await readdir(`${root}/packages/scope-runtime/dist`)).filter(name => /^[a-z][a-z0-9-]*\.js$/.test(name)).sort();
  assert(files.length >= 5 && files.length <= 64, "build_hash_capacity");
  const hashes = {};
  for (const name of files) {
    const path = `${root}/packages/scope-runtime/dist/${name}`;
    await noSymlinkAncestors(path, true); hashes[name] = await hash(path);
  }
  const nodeVersion = await must(NODE, ["--version"], "node_version_failed");
  const nativeVersion = await must(`${native}/claude`, ["--version"], "native_version_failed");
  assert(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion) && Number(nodeVersion.slice(1).split(".")[0]) >= 24, "node_version_invalid");
  const nativeMatch = /^([0-9]+\.[0-9]+\.[0-9]+)(?: \(Claude Code\))?$/.exec(nativeVersion);
  assert(nativeMatch && nativeMatch[1] === sdkManifest.claudeCodeVersion, "native_version_invalid");
  return { node: { path: NODE, version: nodeVersion, sha256: await hash(NODE) },
    sdk: { path: sdk, version: sdkManifest.version, sha256: await hash(`${sdk}/sdk.mjs`) },
    native: { path: `${native}/claude`, version: nativeVersion, sha256: await hash(`${native}/claude`) }, hashes };
}
// Runs with the worker's UID inside its actual mount/root/network namespaces.
// Only booleans and fixed check names leave the namespace; no file contents or environment are read.
const DENIAL_PROBE = `
import { access } from 'node:fs/promises'; import { connect } from 'node:net'; import { networkInterfaces } from 'node:os';
const paths=['/root','/home/matrix/home','/opt/matrix/env/host.env','/run/systemd/private','/run/matrix-scope-runtime/supervisor.sock','/var/lib/matrix-devstack'];
const checks={}; for(const path of paths){ try{await access(path); checks[path]=false;}catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error; checks[path]=true;} }
for(const host of ['127.0.0.1','169.254.169.254','1.1.1.1'])checks['network:'+host]=await new Promise(resolve=>{const s=connect({host,port:80});const done=v=>{s.destroy();resolve(v)};s.setTimeout(1200,()=>done(true));s.once('error',()=>done(true));s.once('connect',()=>done(false));});
checks.no_external_interface=Object.values(networkInterfaces()).flat().every(item=>item.internal); console.log(JSON.stringify(checks));
`;
export async function inspectWorker(config, unit) {
  const keys = ["DynamicUser", "PrivateUsers", "PrivateNetwork", "PrivateIPC", "PrivateDevices", "ProtectSystem", "ProtectHome", "NoNewPrivileges",
    "CapabilityBoundingSet", "AmbientCapabilities", "ProtectProc", "ProcSubset", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectControlGroups", "ProtectClock", "ProtectHostname", "RestrictAddressFamilies", "RestrictNamespaces", "RestrictRealtime", "RestrictSUIDSGID", "SystemCallArchitectures", "PrivateTmp", "MountAPIVFS", "UMask", "RuntimeMaxUSec", "TimeoutStopUSec", "TemporaryFileSystem", "BindReadOnlyPaths", "BindPaths", "MemoryMax", "TasksMax", "CPUQuotaPerSecUSec", "RootDirectory", "WorkingDirectory", "MainPID", "ControlGroup"];
  const properties = await show(unit, keys);
  const expected = { DynamicUser: "yes", PrivateUsers: "yes", PrivateNetwork: "yes", PrivateIPC: "yes", PrivateDevices: "yes", ProtectSystem: "strict",
    ProtectHome: "yes", NoNewPrivileges: "yes", ProtectProc: "invisible", ProcSubset: "pid", ProtectKernelTunables: "yes", ProtectKernelModules: "yes", ProtectKernelLogs: "yes", ProtectControlGroups: "yes", ProtectClock: "yes", ProtectHostname: "yes", RestrictRealtime: "yes", RestrictSUIDSGID: "yes", PrivateTmp: "yes", MountAPIVFS: "yes", UMask: "0077", CapabilityBoundingSet: "", AmbientCapabilities: "", MemoryMax: "1073741824", TasksMax: "256", CPUQuotaPerSecUSec: "2s", WorkingDirectory: "/workspace" };
  assert(Object.entries(expected).every(([key, value]) => properties[key] === value), "worker_fixed_profile_mismatch");
  const suffix = unit.slice(config.workerUnitPrefix.length, -8);
  assert(properties.RootDirectory === `${config.stateRoot}/runtimes/${suffix}/root`, "worker_root_mismatch");
  const pid = Number(properties.MainPID); assert(Number.isInteger(pid) && pid > 1, "worker_pid_invalid");
  const status = await readFile(`/proc/${pid}/status`, "utf8"); const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]); const gid = Number(/^Gid:\s+(\d+)/m.exec(status)?.[1]);
  assert(uid >= 61184 && uid <= 65519 && Number.isInteger(gid), "worker_identity_invalid");
  const namespaces = {};
  for (const name of ["mnt", "net"]) { namespaces[name] = await readlink(`/proc/${pid}/ns/${name}`);
    assert(namespaces[name] !== await readlink(`/proc/self/ns/${name}`), "worker_namespace_not_isolated"); }
  const actualRoot = await readlink(`/proc/${pid}/root`);
  assert(actualRoot.length <= 4096, "worker_root_evidence_invalid");
  const cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
  assert(cgroup.includes(`/${unit}`) && properties.ControlGroup.endsWith(`/${unit}`), "worker_cgroup_mismatch");
  const denial = JSON.parse(await must("/usr/bin/nsenter", [`--target=${pid}`, "--mount", "--net", "--root", "--wd", `--setuid=${uid}`, `--setgid=${gid}`,
    "--", NODE, "--input-type=module", "-e", DENIAL_PROBE], "worker_denial_probe_failed", 10_000));
  assert(Object.keys(denial).length === 10 && Object.values(denial).every(value => value === true), "worker_denial_failed");
  return { properties, actualRoot, uid, gid, namespaces, cgroup, denial };
}
