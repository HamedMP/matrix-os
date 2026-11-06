// Privileged harness observation only. Never imported by the capability-free supervisor.
import { readFile, readlink } from "node:fs/promises";
import { assert, command } from "./control.mjs";
const GROUP = "matrix", WORKLOAD = "matrix-scope-workload";
const CAPABILITIES = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
function id(value) {
  assert(/^(0|[1-9][0-9]{0,9})$/.test(value) && Number(value) < 0xffffffff, "process_identity_invalid");
  return Number(value);
}
export async function lookupIpcIdentity(worker = false) {
  const lookup = async database => {
    const result = await command("/usr/bin/getent", [database, database === "group" ? GROUP : WORKLOAD], 2000);
    assert(result.code === 0 && !result.stderrPresent && typeof result.stdout === "string" && result.stdout.length <= 4096, "ipc_identity_lookup_failed");
    return result.stdout;
  };
  const group = /^matrix:[^:\n]*:([0-9]{1,10}):[^:\n]*\n?$/.exec(await lookup("group"));
  assert(group, "ipc_group_lookup_invalid"); const trustedGroup = { name: GROUP, gid: id(group[1]) };
  assert(trustedGroup.gid > 0, "ipc_group_lookup_invalid");
  if (!worker) return { trustedGroup };
  const passwd = /^matrix-scope-workload:[^:\n]*:([0-9]{1,10}):([0-9]{1,10}):[^:\n]*:[^:\n]*:[^:\n]*\n?$/.exec(await lookup("passwd"));
  assert(passwd, "ipc_workload_lookup_invalid"); const uid = id(passwd[1]), gid = id(passwd[2]);
  assert(uid >= 61184 && uid <= 65519 && gid >= 61184 && gid <= 65519 && gid !== trustedGroup.gid, "ipc_workload_lookup_invalid");
  return { trustedGroup, workload: { name: WORKLOAD, uid, gid } };
}
function map(raw) {
  assert(typeof raw === "string" && raw.length > 0 && raw.length <= 4096, "process_map_missing");
  const rows = raw.trim().split("\n"); assert(rows.length <= 32, "process_map_capacity");
  const entries = rows.map(row => {
    const match = /^\s*([0-9]{1,10})\s+([0-9]{1,10})\s+([0-9]{1,10})\s*$/.exec(row);
    assert(match, "process_map_invalid"); const [inside, outside, count] = match.slice(1).map(Number);
    assert(count > 0 && inside + count <= 0xffffffff && outside + count <= 0xffffffff, "process_map_invalid");
    return { inside, outside, count };
  });
  for (const field of ["inside", "outside"]) {
    const sorted = [...entries].sort((a, b) => a[field] - b[field]);
    for (let i = 1; i < sorted.length; i++) assert(sorted[i - 1][field] + sorted[i - 1].count <= sorted[i][field], "process_map_overlap");
  }
  return entries.sort((a, b) => a.inside - b.inside);
}
function status(raw) {
  assert(typeof raw === "string" && raw.length <= 65536, "process_status_invalid");
  const field = key => {
    const matches = [...raw.matchAll(new RegExp(`^${key}:([^\\n]*)$`, "gm"))];
    assert(matches.length === 1, "process_status_field_missing"); return matches[0][1].trim();
  };
  const vector = key => { const values = field(key).split(/\s+/); assert(values.length === 4, "process_vector_invalid"); return values.map(id); };
  const rawGroups = field("Groups"), groups = rawGroups ? rawGroups.split(/\s+/).map(id).sort((a, b) => a - b) : [];
  assert(groups.length <= 128 && new Set(groups).size === groups.length, "process_groups_invalid");
  const capabilities = Object.fromEntries(CAPABILITIES.map(key => {
    const value = field(key); assert(/^[a-f0-9]{16}$/.test(value) && /^0+$/.test(value), "process_capabilities_not_empty"); return [key, value];
  }));
  assert(field("NoNewPrivs") === "1", "process_no_new_privileges_missing");
  return { uids: vector("Uid"), gids: vector("Gid"), groups, capabilities, noNewPrivileges: true };
}
function starttime(raw, pid) {
  assert(typeof raw === "string" && raw.length <= 4096 && raw.startsWith(`${pid} (`), "process_stat_invalid");
  const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/), value = fields[19];
  assert(/^[1-9][0-9]{0,19}$/.test(value), "process_starttime_invalid"); return value;
}
export async function observeCredentials(pid, identity, worker) {
  assert(Number.isSafeInteger(pid) && pid > 1, "process_pid_invalid");
  const path = `/proc/${pid}`, before = starttime(await readFile(`${path}/stat`, "utf8"), pid);
  const observed = status(await readFile(`${path}/status`, "utf8"));
  const userNamespace = await readlink(`${path}/ns/user`), hostUserNamespace = await readlink("/proc/self/ns/user");
  assert(/^user:\[[1-9][0-9]*\]$/.test(userNamespace) && /^user:\[[1-9][0-9]*\]$/.test(hostUserNamespace), "process_user_namespace_invalid");
  const uidMap = map(await readFile(`${path}/uid_map`, "utf8")), gidMap = map(await readFile(`${path}/gid_map`, "utf8"));
  const expected = worker ? identity.workload : { uid: 0, gid: identity.trustedGroup.gid };
  assert(observed.uids.every(value => value === expected.uid) && observed.gids.every(value => value === expected.gid)
    && observed.groups.length === 1 && observed.groups[0] === expected.gid, "process_credentials_drift");
  if (worker) {
    assert(userNamespace !== hostUserNamespace && !observed.groups.includes(identity.trustedGroup.gid), "worker_trusted_group_or_namespace");
    // PrivateUsers=yes semantics from the source profile and focused Linux proof:
    // identity-map root and the fixed dynamic service identity, nothing else.
    const expectedMap = value => [{ inside: 0, outside: 0, count: 1 }, { inside: value, outside: value, count: 1 }];
    assert(JSON.stringify(uidMap) === JSON.stringify(expectedMap(expected.uid)) && JSON.stringify(gidMap) === JSON.stringify(expectedMap(expected.gid)), "worker_user_maps_drift");
  } else {
    assert(userNamespace === hostUserNamespace && JSON.stringify(uidMap) === JSON.stringify(map(await readFile("/proc/self/uid_map", "utf8")))
      && JSON.stringify(gidMap) === JSON.stringify(map(await readFile("/proc/self/gid_map", "utf8"))), "supervisor_user_maps_drift");
  }
  assert(before === starttime(await readFile(`${path}/stat`, "utf8"), pid), "process_incarnation_changed");
  return { ...observed, pid, starttime: before, userNamespace, hostUserNamespace, uidMap, gidMap };
}
export function assertStableProcess(before, after) {
  assert(JSON.stringify(before) === JSON.stringify(after), "process_evidence_changed");
}
export function assertActiveUnit(properties, unit) {
  assert(properties.Id === unit && properties.ActiveState === "active" && properties.SubState === "running"
    && /^[1-9][0-9]{0,9}$/.test(properties.MainPID) && Number(properties.MainPID) > 1
    && /^[a-f0-9]{32}$/.test(properties.InvocationID) && !/^0+$/.test(properties.InvocationID), "process_unit_identity_invalid");
}
export function assertStableUnit(before, after) {
  assert(JSON.stringify(before) === JSON.stringify(after), "process_unit_identity_changed");
}
