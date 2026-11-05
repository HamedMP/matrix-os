import { assert } from "./control.mjs";
const yesKeys = ["MountAPIVFS", "PrivateNetwork", "PrivateIPC", "PrivateDevices", "ProtectKernelTunables", "ProtectKernelModules", "ProtectKernelLogs", "ProtectControlGroups", "ProtectClock", "ProtectHostname", "NoNewPrivileges", "RestrictRealtime", "RestrictSUIDSGID"];
export const COMMON_SECURITY_KEYS = [...yesKeys, "Type", "User", "Group", "DynamicUser", "PrivateUsers", "PrivateTmp", "ProtectProc", "ProcSubset", "ProtectSystem", "ProtectHome", "CapabilityBoundingSet", "AmbientCapabilities", "RestrictAddressFamilies", "RestrictNamespaces", "SystemCallArchitectures", "MemoryMax", "TasksMax", "UMask", "RootDirectory", "RuntimeMaxUSec", "TimeoutStopUSec", "BindPaths", "BindReadOnlyPaths", "KillMode"];
export const WORKER_SECURITY_KEYS = [...COMMON_SECURITY_KEYS, "CPUQuotaPerSecUSec", "TemporaryFileSystem", "WorkingDirectory", "MainPID", "ControlGroup"];
export const SUPERVISOR_SECURITY_KEYS = [...COMMON_SECURITY_KEYS, "RuntimeDirectory", "RuntimeDirectoryMode", "StateDirectory", "StateDirectoryMode", "ReadWritePaths", "WatchdogUSec", "NotifyAccess", "Restart", "RestartUSec"];
function list(value) { assert(typeof value === "string" && value.length <= 16384 && !/[\n\r\\]/.test(value), "security_value_invalid"); return value.split(/\s+/).filter(Boolean).sort(); }
function same(value, expected) { assert(JSON.stringify(value) === JSON.stringify(expected), "security_property_drift"); }
export function duration(value) {
  assert(typeof value === "string", "duration_invalid"); let total = 0, consumed = "";
  for (const match of value.matchAll(/([0-9]+(?:\.[0-9]+)?)(us|ms|s|min|h)/g)) { consumed += match[0]; total += Number(match[1]) * ({ us: 0.001, ms: 1, s: 1000, min: 60000, h: 3600000 })[match[2]]; }
  assert(consumed === value.replaceAll(" ", "") && total > 0, "duration_invalid"); return total;
}
function bindList(value) {
  return list(value).map(item => {
    const fields = item.split(":"); assert(fields.length <= 3 && fields[0], "bind_invalid");
    const optional = fields[0].startsWith("-"); const source = optional ? fields[0].slice(1) : fields[0];
    const destination = fields[1] || source, mode = fields[2] || "rbind";
    assert(source.startsWith("/") && destination.startsWith("/") && !source.includes("..") && !destination.includes("..") && ["rbind", "norbind"].includes(mode), "bind_invalid");
    return `${optional ? "-" : ""}${source}:${destination}:${mode}`;
  }).sort();
}
function temporaryFilesystems(value) {
  return list(value).map(item => {
    const [path, raw, extra] = item.split(":"); assert(raw && !extra, "tmpfs_invalid");
    const options = raw.split(",").map(option => {
      const size = /^size=([0-9]+)([KMG]?)$/.exec(option);
      if (size) return `size=${Number(size[1]) * ({ "": 1, K: 1024, M: 1048576, G: 1073741824 })[size[2]]}`;
      const mode = /^mode=([0-7]+)$/.exec(option); return mode ? `mode=${Number.parseInt(mode[1], 8).toString(8)}` : option;
    }).sort(); return `${path}:${options.join(",")}`;
  }).sort();
}
function base(properties, requireMountApi = true) {
  for (const key of yesKeys.filter(key => requireMountApi || key !== "MountAPIVFS")) same(properties[key], "yes");
  for (const [key, value] of Object.entries({ ProtectProc: "invisible", ProcSubset: "pid", ProtectSystem: "strict", CapabilityBoundingSet: "", AmbientCapabilities: "", RestrictNamespaces: "yes" })) same(properties[key], value);
  same(list(properties.SystemCallArchitectures), ["native"]);
}
export function validateWorkerProperties(properties, config, handle, dependencies) {
  assert(/^runtime_[a-f0-9]{32}$/.test(handle), "worker_handle_invalid"); const suffix = handle.slice(8), root = `${config.stateRoot}/runtimes/${suffix}`;
  base(properties);
  assert(["", "matrix-scope-workload"].includes(properties.Group ?? ""), "worker_group_drift");
  for (const [key, value] of Object.entries({ Type: "exec", User: "matrix-scope-workload", KillMode: "control-group", DynamicUser: "yes", PrivateUsers: "yes", PrivateTmp: "yes", ProtectHome: "yes", RootDirectory: `${root}/root`, MemoryMax: "1073741824", TasksMax: "256", UMask: "0077", WorkingDirectory: "/workspace" })) same(properties[key], value);
  same(list(properties.RestrictAddressFamilies), ["AF_INET", "AF_INET6", "AF_UNIX"]);
  same(duration(properties.CPUQuotaPerSecUSec), 2000); same(duration(properties.RuntimeMaxUSec), 90000); same(duration(properties.TimeoutStopUSec), 10000);
  const readonly = ["/lib", "/lib64", "/usr/lib", "/usr/bin/env", "/opt/matrix/runtime/node"].map(path => `${path}:${path}:rbind`);
  readonly.push(`${dependencies.sdk.root}:/opt/matrix/scope-sdk/sdk:rbind`, `${dependencies.native.root}:/opt/matrix/scope-sdk/native:rbind`, `${dependencies.workerFile}:/opt/matrix/scope-runtime/worker.mjs:rbind`);
  same(bindList(properties.BindReadOnlyPaths), readonly.sort());
  same(bindList(properties.BindPaths), [`${config.brokerSocket}:/run/matrix-scope/broker.sock:rbind`, `${root}/ready:/run/matrix-scope-readiness/ready:rbind`, `${config.commandSocketRoot}/${suffix}:/run/matrix-scope-command:rbind`].sort());
  same(temporaryFilesystems(properties.TemporaryFileSystem), temporaryFilesystems("/workspace:rw,nosuid,nodev,size=10G,mode=1777 /tmp:rw,nosuid,nodev,noexec,size=64M,mode=1777"));
  return { ...properties, BindReadOnlyPaths: bindList(properties.BindReadOnlyPaths), BindPaths: bindList(properties.BindPaths), TemporaryFileSystem: temporaryFilesystems(properties.TemporaryFileSystem) };
}
export function validateSupervisorProperties(properties, config) {
  // The fixture tightens its own IPC directory only. Legacy and fixed workers
  // retain their source profiles; this does not qualify non-root Gateway IPC.
  base(properties, false);
  for (const [key, value] of Object.entries({ Type: "simple", User: "root", Group: "matrix", DynamicUser: "no", PrivateUsers: "no", PrivateTmp: "no", ProtectHome: "tmpfs", RootDirectory: "", MemoryMax: "268435456", TasksMax: "64", UMask: "0007", RuntimeDirectoryMode: "0700", StateDirectoryMode: "0700", NotifyAccess: "all", Restart: "on-failure", KillMode: "control-group" })) same(properties[key], value);
  same(list(properties.RestrictAddressFamilies), ["AF_UNIX"]); same(duration(properties.RuntimeMaxUSec), 180000); same(duration(properties.TimeoutStopUSec), 45000);
  same(duration(properties.WatchdogUSec), 60000); same(duration(properties.RestartUSec), 5000);
  same(list(properties.ReadWritePaths), [config.runtimeDirectory, config.commandSocketRoot].sort());
  same(list(properties.RuntimeDirectory), [`matrix-devstack/${config.namespace}/scope-runtime`, `matrix-devstack/${config.namespace}/c`].sort());
  same(list(properties.StateDirectory), [`matrix-devstack/${config.namespace}/scope-runtime`]);
  same(bindList(properties.BindPaths), []);
  same(bindList(properties.BindReadOnlyPaths), ["bots", "agent-workspaces", "projects", "worktrees"].map(name => `-${config.home}/${name}:${config.home}/${name}:rbind`).sort());
  return { properties: { ...properties, BindReadOnlyPaths: bindList(properties.BindReadOnlyPaths), BindPaths: [], ReadWritePaths: list(properties.ReadWritePaths) }, fixture: "root_only_native_ipc", nonRootGatewayAcceptance: "not_tested" };
}
export function assertRootIdentity(actual, expected) {
  assert(actual.ino === expected.ino && actual.dev === expected.dev, "actual_root_object_mismatch");
  return { inode: String(actual.ino), device: String(actual.dev) };
}
