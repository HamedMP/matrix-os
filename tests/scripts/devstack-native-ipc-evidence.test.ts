import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ status: "", uidMap: "", gidMap: "", entries: ["worker.sock", ".w-ABC123"], stageEntries: [] as string[],
  anchors: {} as Record<string, any>, parent: {} as any, socket: {} as any, stage: {} as any, properties: {} as any, group: "matrix:x:987:", passwd: "matrix-scope-workload:x:62001:62001::/:/usr/sbin/nologin", calls: [] as string[], reads: 0, change: false, absent: false }));
vi.mock("../../scripts/ops/devstack-native/baseline.mjs", () => ({ show: async () => {
  const result = { ...f.properties }; if (f.change && ++f.reads > 1) result.InvocationID = "b".repeat(32); return result;
} }));
vi.mock("../../scripts/ops/devstack-native/security.mjs", async original => ({ ...await original<any>(),
  validateWorkerProperties: (properties: any) => properties, validateSupervisorProperties: (properties: any) => ({ properties }) }));
vi.mock("../../scripts/ops/devstack-native/control.mjs", async original => ({ ...await original<any>(),
  command: async (binary: string, args: string[]) => { f.calls.push(binary + " " + args.join(" ")); return { code: 0, stdout: args[0] === "group" ? f.group : f.passwd }; } }));
vi.mock("../../scripts/ops/devstack-native/node-evidence.mjs", () => ({
  verifyExecutableEvidence: async () => ({ sha256: "owned-node" }), withVerifiedWorkerNode: async () => ({ node: { sha256: "owned-node" } }), runPinnedDenialProbe: vi.fn(),
}));
vi.mock("node:fs/promises", async original => ({ ...await original<any>(),
  open: async () => ({ stat: async () => ({ ino: 1n, dev: 2n }), close: async () => {} }),
  readlink: async (path: string) => path.endsWith("/user") ? (path.includes("/self/") || f.properties.User === "root" ? "user:[1]" : "user:[2]") : path.includes("/self/") ? "ns:[1]" : "ns:[2]",
  readFile: async (path: string) => {
    if (path.endsWith("/status")) return f.status;
    if (path.endsWith("/uid_map")) return path.includes("/self/") ? "0 0 4294967295\n" : f.uidMap;
    if (path.endsWith("/gid_map")) return path.includes("/self/") ? "0 0 4294967295\n" : f.gidMap;
    if (path.endsWith("/cgroup")) return "0::" + f.properties.ControlGroup;
    if (path.endsWith("/stat")) return "42 (fixture) S " + Array(18).fill("0").join(" ") + " 123 0\n";
    throw Error("unexpected_read");
  },
  lstat: async (path: string) => { if (f.absent && path.endsWith("a".repeat(32))) throw Object.assign(Error("absent"), { code: "ENOENT" }); return f.anchors[path] ?? (path.endsWith("worker.sock") ? f.socket : path.endsWith(".w-ABC123") ? f.stage : path.endsWith("a".repeat(32)) ? f.parent : metadata(0o700, 0, 987)); },
  opendir: async (path: string) => ({ async *[Symbol.asyncIterator]() { for (const name of path.endsWith(".w-ABC123") ? f.stageEntries : f.entries) yield { name }; } }),
}));
import { inspectSupervisor, inspectWorkerConfiguration } from "../../scripts/ops/devstack-native/evidence.mjs";
import { inspectCommandCleanup } from "../../scripts/ops/devstack-native/ipc-evidence.mjs";
import { safeCapability } from "../../scripts/ops/devstack-native/receipt.mjs";
const handle = "runtime_" + "a".repeat(32), unit = "fixture-" + "a".repeat(32) + ".service";
const config = { supervisorUnit: "fixture.service", workerUnitPrefix: "fixture-", commandSocketRoot: "/owned/c", runtimeDirectory: "/owned/ipc", stateRoot: "/owned/state", ownedNode: { binary: "/owned/node", workerBinary: "/node" } };
function status(uid = 62001, gid = 62001, groups = "62001") {
  return `Name:\tfixture\nUid:\t${[uid, uid, uid, uid].join("\t")}\nGid:\t${[gid, gid, gid, gid].join("\t")}\nGroups:\t${groups}\n` + ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(key => key + ":\t0000000000000000\n").join("") + "NoNewPrivs:\t1\n";
}
const metadata = (mode: number, uid: number, gid: number, socket = false) => ({ mode, uid, gid, ino: socket ? 4 : 3, dev: 2, nlink: socket ? 1 : 2, isDirectory: () => !socket, isSocket: () => socket, isSymbolicLink: () => false });
beforeEach(() => {
  f.anchors = { "/owned/state": metadata(0o2700, 0, 987), "/owned/state/runtimes": metadata(0o2700, 0, 987),
    "/owned/ipc": metadata(0o2770, 0, 987), "/owned/c": metadata(0o2770, 0, 987),
    ["/owned/state/runtimes/" + "a".repeat(32)]: metadata(0o2700, 0, 987) };
  Object.assign(f, { status: status(), uidMap: "0 0 1\n62001 62001 1\n", gidMap: "0 0 1\n62001 62001 1\n", entries: ["worker.sock", ".w-ABC123"], stageEntries: [], group: "matrix:x:987:", passwd: "matrix-scope-workload:x:62001:62001::/:/usr/sbin/nologin", calls: [], reads: 0, change: false, absent: false,
    parent: metadata(0o2733, 0, 987), socket: metadata(0o620, 62001, 987, true), stage: metadata(0o2700, 62001, 987),
    properties: { Id: unit, User: "matrix-scope-workload", DynamicUser: "yes", PrivateUsers: "yes", MainPID: "42", InvocationID: "a".repeat(32), ActiveState: "active", SubState: "running", RootDirectory: "/owned/root", ControlGroup: "/system.slice/" + unit } });
});
const inspect = () => inspectWorkerConfiguration(config, handle, {}, unit, {});
it("records all host credential vectors/maps, inherited IPC modes and empty retained bind stage without consuming the socket", async () => {
  const result = await inspect();
  expect(result.credentials).toMatchObject({ uids: [62001, 62001, 62001, 62001], gids: [62001, 62001, 62001, 62001], groups: [62001], userNamespace: "user:[2]", uidMap: [{ inside: 0, outside: 0, count: 1 }, { inside: 62001, outside: 62001, count: 1 }] });
  expect(result.commandIpc).toMatchObject({ trustedGroup: { name: "matrix", gid: 987 }, parent: { mode: "2733", uid: 0, gid: 987 }, socket: { mode: "0620", uid: 62001, gid: 987, links: 1 }, staging: { mode: "2700", uid: 62001, gid: 987, empty: true }, hostConnections: 0 });
  expect(f.calls).toEqual(["/usr/bin/getent group matrix", "/usr/bin/getent passwd matrix-scope-workload"]);
});
it.each(["missing_uid", "saved_uid", "filesystem_gid", "missing_groups", "trusted_group", "unexpected_group", "missing_caps", "caps", "missing_map", "unmapped_uid", "trusted_gid_map", "overlapping_map", "changed_unit", "wrong_lookup", "extra_lookup"])("rejects %s host credential evidence", async fault => {
  if (fault === "missing_uid") f.status = f.status.replace(/^Uid:.*\n/m, "");
  if (fault === "saved_uid") f.status = f.status.replace("Uid:\t62001\t62001\t62001\t62001", "Uid:\t62001\t62001\t0\t62001");
  if (fault === "filesystem_gid") f.status = f.status.replace("Gid:\t62001\t62001\t62001\t62001", "Gid:\t62001\t62001\t62001\t987");
  if (fault === "missing_groups") f.status = f.status.replace(/^Groups:.*\n/m, "");
  if (fault === "trusted_group") f.status = status(62001, 62001, "987 62001");
  if (fault === "unexpected_group") f.status = status(62001, 62001, "62001 555");
  if (fault === "missing_caps") f.status = f.status.replace(/^CapAmb:.*\n/m, "");
  if (fault === "caps") f.status = f.status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001");
  if (fault === "missing_map") f.uidMap = "";
  if (fault === "unmapped_uid") f.uidMap = "0 0 1\n";
  if (fault === "trusted_gid_map") f.gidMap += "987 987 1\n";
  if (fault === "overlapping_map") f.uidMap += "62001 62001 2\n";
  if (fault === "changed_unit") f.change = true;
  if (fault === "wrong_lookup") f.group = "other:x:987:";
  if (fault === "extra_lookup") f.passwd += "\nother:x:62001:62001::/:/bin/sh";
  await expect(inspect()).rejects.toThrow();
});
it.each(["socket_mode", "socket_gid", "socket_uid", "links", "parent_mode", "parent_gid", "stage_mode", "stage_gid", "stage_uid", "stage_missing", "stage_nonempty", "extra_entry"])("rejects %s command publication evidence", async fault => {
  if (fault === "socket_mode") f.socket.mode = 0o666;
  if (fault === "socket_gid") f.socket.gid = 62001;
  if (fault === "socket_uid") f.socket.uid = 62002;
  if (fault === "links") f.socket.nlink = 2;
  if (fault === "parent_mode") f.parent.mode = 0o733;
  if (fault === "parent_gid") f.parent.gid = 62001;
  if (fault === "stage_mode") f.stage.mode = 0o700;
  if (fault === "stage_gid") f.stage.gid = 62001;
  if (fault === "stage_uid") f.stage.uid = 0;
  if (fault === "stage_missing") f.entries = ["worker.sock"];
  if (fault === "stage_nonempty") f.stageEntries = ["s"];
  if (fault === "extra_entry") f.entries.push("foreign");
  await expect(inspect()).rejects.toThrow();
});
it.each(["valid", "uid", "gid", "groups", "caps", "map"])("attests root/trusted-group capability-free supervisor: %s", async fault => {
  f.properties.User = "root"; f.properties.Id = config.supervisorUnit; f.status = status(0, 987, "987"); f.uidMap = f.gidMap = "0 0 4294967295\n";
  if (fault === "uid") f.status = status(1, 987, "987");
  if (fault === "gid") f.status = status(0, 62001, "987");
  if (fault === "groups") f.status = status(0, 987, "987 10");
  if (fault === "caps") f.status = f.status.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000000001");
  if (fault === "map") f.gidMap = "0 0 1\n";
  if (fault === "valid") expect(await inspectSupervisor(config, {})).toMatchObject({ credentials: { uids: [0, 0, 0, 0], gids: [987, 987, 987, 987], groups: [987] } });
  else await expect(inspectSupervisor(config, {})).rejects.toThrow();
});
it("rejects the old Chat v2 capability fence", () => {
  expect(() => safeCapability({ profile: { profileId: "scope-runtime-chat-v1", profileVersion: 2, profileDigest: "a".repeat(64), executionGeneration: "1", adapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240" }] } })).toThrow("capability_invalid");
});

it.each(["valid", "live", "pid", "control_pid", "cgroup", "wrong_unit", "missing_root", "retained_directory"])("requires later exact-unit quiescence and actual staging tree removal: %s", async fault => {
  f.absent = true; f.parent = metadata(0o700, 0, 987);
  f.properties = { Id: unit, LoadState: "not-found", ActiveState: "inactive", SubState: "dead", MainPID: "0", ControlPID: "0", ControlGroup: "", RootDirectory: "" };
  if (fault === "live") f.properties.ActiveState = "deactivating";
  if (fault === "pid") f.properties.MainPID = "42";
  if (fault === "control_pid") f.properties.ControlPID = "42";
  if (fault === "cgroup") f.properties.ControlGroup = "/system.slice/" + unit;
  if (fault === "wrong_unit") f.properties.Id = "foreign.service";
  if (fault === "missing_root") delete f.properties.RootDirectory;
  if (fault === "retained_directory") f.absent = false;
  if (fault === "valid") expect(await inspectCommandCleanup(config, [handle])).toMatchObject({ workers: [{ handle, retainedEmptyStagingRemoved: true }], units: [{ Id: unit, ControlGroup: "" }] });
  else await expect(inspectCommandCleanup(config, [handle])).rejects.toThrow();
});

it.each(["/owned/state", "/owned/state/runtimes", "/owned/ipc", "/owned/c"])("requires inherited mode and trusted group at the declared anchor %s", async path => {
  f.properties.User = "root"; f.properties.Id = config.supervisorUnit; f.status = status(0, 987, "987"); f.uidMap = f.gidMap = "0 0 4294967295\n";
  f.anchors[path].mode &= 0o777;
  await expect(inspectSupervisor(config, {})).rejects.toThrow();
  f.anchors[path].mode |= 0o2000; f.anchors[path].gid = 999;
  await expect(inspectSupervisor(config, {})).rejects.toThrow();
});
it("requires inherited private runtime2700 before accepting a worker", async () => {
  f.anchors["/owned/state/runtimes/" + "a".repeat(32)].mode = 0o700;
  await expect(inspect()).rejects.toThrow();
});
