import { openSync, readSync, closeSync, statSync } from "node:fs";
import { cpus, availableParallelism, platform } from "node:os";
import { posix } from "node:path";
import type { CpuObservation, CpuObservations } from "@matrix-os/contracts";

const MAX_BYTES = 65_536;
const MAX_ANCESTORS = 64;
const MAX_CPU_ID = 1_048_575;
// Linux UAPI include/uapi/linux/nsfs.h: CGROUP_NS_INIT_INO. Dynamic
// namespace inode numbers cannot prove that host ancestry is visible.
const INITIAL_CGROUP_NAMESPACE_INODE = 0xEFFFFFFB;
const unknown = { status: "unavailable" } as const;
const known = <T>(value: T): CpuObservation<T> => ({ status: "known", value });

type Interval = [number, number];
type ReadText = (path: string) => string;

function readSmallFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytes === 0) break;
      length += bytes;
    }
    if (length > MAX_BYTES) throw new Error("CPU observation exceeds limit");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function intervals(text: string): Interval[] {
  if (!text.trim()) return [];
  const result: Interval[] = [];
  for (const part of text.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error("Invalid CPU list");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start > end || end > MAX_CPU_ID || (result.length && start <= result[result.length - 1]![1])) throw new Error("Invalid CPU range");
    result.push([start, end]);
  }
  return result;
}

function intersect(left: Interval[], right: Interval[]): Interval[] {
  const result: Interval[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i]!, b = right[j]!;
    const start = Math.max(a[0], b[0]), end = Math.min(a[1], b[1]);
    if (start <= end) result.push([start, end]);
    if (a[1] < b[1]) i += 1; else j += 1;
  }
  return result;
}
const count = (ranges: Interval[]) => ranges.reduce((total, [start, end]) => total + end - start + 1, 0);

function safePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid cgroup path");
  return path;
}
function mountPath(value: string): string {
  return safePath(value.replace(/\\(040|011|012|134)/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8))));
}

function ancestors(membership: string, mountinfo: string, controller: "cpu" | "cpuset" | "v2"): string[] {
  const entries = membership.trim().split("\n").map(line => {
    const match = /^(\d+):([^:]*):(\/.*)$/.exec(line);
    if (!match) throw new Error("Invalid cgroup membership");
    return match.slice(1);
  });
  const entry = entries.find(parts => controller === "v2" ? parts[0] === "0" && parts[1] === "" : parts[1]?.split(",").includes(controller));
  if (!entry) return [];
  if (entry.length !== 3 || !entry[2]) throw new Error("Invalid cgroup membership");
  const group = safePath(entry[2]);
  for (const line of mountinfo.trim().split("\n")) {
    const [before, after] = line.split(" - ");
    const fields = before?.split(" "), fs = after?.split(" ");
    if (!fields || !fs || !(controller === "v2" ? fs[0] === "cgroup2" : fs[0] === "cgroup" && fs[2]?.split(",").includes(controller))) continue;
    const root = mountPath(fields[3] ?? ""), mount = mountPath(fields[4] ?? "");
    // A sub-tree mount hides potentially tighter ancestors; do not invent truth.
    if (root !== "/") throw new Error("Cgroup ancestry unavailable");
    let current = posix.resolve(mount, `.${group}`);
    const paths: string[] = [];
    while (current === mount || current.startsWith(`${mount}/`)) {
      if (paths.length >= MAX_ANCESTORS) throw new Error("Cgroup hierarchy exceeds limit");
      paths.push(current);
      if (current === mount) return paths;
      current = posix.dirname(current);
    }
    throw new Error("Invalid cgroup boundary");
  }
  throw new Error("Cgroup mount unavailable");
}

function positiveInteger(text: string): number {
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) throw new Error("Invalid CPU quota");
  return Number(text);
}

/** Read only the gateway process's observed constraints; no plan inference. */
export function readCpuObservations(options: { visibleLogicalCpuCount?: number; platform?: string; readText?: ReadText } = {}): CpuObservations {
  const visibleLogicalCpuCount = options.visibleLogicalCpuCount ?? cpus().length;
  const result: CpuObservations = { visibleLogicalCpuCount, affinity: unknown, cpusets: [unknown], quotas: [unknown] };
  if ((options.platform ?? platform()) !== "linux") {
    try { result.affinity = known(availableParallelism()); } catch (error) { console.warn("[cpu-capacity] native affinity unavailable", error instanceof Error ? error.name : "unknown"); }
    result.cpusets = [known(null)]; result.quotas = [known(null)];
    return result;
  }
  const read = (path: string) => {
    const text = (options.readText ?? readSmallFile)(path);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("CPU observation exceeds limit");
    return text.trim();
  };
  try {
    const status = read("/proc/self/status").match(/^Cpus_allowed_list:\s*([^\n]+)$/m);
    if (!status) throw new Error("Affinity unavailable");
    let eligible = intervals(status[1]!);
    if (!eligible.length) throw new Error("Affinity unavailable");
    result.affinity = known(count(eligible));
    if (statSync("/proc/self/ns/cgroup").ino !== INITIAL_CGROUP_NAMESPACE_INODE) throw new Error("Cgroup namespace ancestry unavailable");
    const membership = read("/proc/self/cgroup"), mountinfo = read("/proc/self/mountinfo");
    if (!membership || !mountinfo) throw new Error("Cgroup discovery unavailable");
    const v2 = membership.split("\n").some(line => line.startsWith("0::"));
    const v2Paths = v2 ? ancestors(membership, mountinfo, "v2") : [];
    const root = v2Paths.at(-1);
    const usesV1 = (controller: string) => membership.split("\n").some(line => line.split(":")[1]?.split(",").includes(controller));
    const cpuV2 = v2 && !usesV1("cpu"), cpusetV2 = v2 && !usesV1("cpuset");
    // CPU bandwidth has no interface on the real v2 root. Namespace identity
    // was checked above: a namespace root is not interchangeable with it.
    const quotaPaths = cpuV2 ? v2Paths.slice(0, -1) : ancestors(membership, mountinfo, "cpu");
    const cpusetPaths = cpusetV2 ? v2Paths : ancestors(membership, mountinfo, "cpuset");
    const controllers = (path: string) => {
      const words = read(path).split(/\s+/).filter(Boolean);
      if (words.some(word => !/^[a-z0-9_]+$/.test(word))) throw new Error("Invalid controller record");
      return words;
    };
    const controllerActive = (path: string, controller: string) => root === path
      ? controllers(`${path}/cgroup.controllers`).includes(controller)
      : controllers(`${posix.dirname(path)}/cgroup.subtree_control`).includes(controller);
    result.quotas = quotaPaths.length ? quotaPaths.map(path => {
      if (cpuV2 && !controllerActive(path, "cpu")) return known(null);
      const parts = cpuV2 ? read(`${path}/cpu.max`).split(/\s+/) : [read(`${path}/cpu.cfs_quota_us`), read(`${path}/cpu.cfs_period_us`)];
      if (parts.length !== 2) throw new Error("Invalid CPU quota");
      const periodMicros = positiveInteger(parts[1]!);
      return known(parts[0] === (cpuV2 ? "max" : "-1") ? null : { quotaMicros: positiveInteger(parts[0]!), periodMicros });
    }) : [known(null)];
    result.cpusets = cpusetPaths.length ? cpusetPaths.map(path => {
      if (cpusetV2 && !controllerActive(path, "cpuset")) return known(null);
      const set = intervals(read(`${path}/${cpusetV2 ? "cpuset.cpus.effective" : "cpuset.cpus"}`));
      if (!set.length && cpusetV2) throw new Error("Effective cpuset unavailable");
      if (!set.length) return known(null); // v1 empty configuration inherits parent
      eligible = intersect(eligible, set);
      return known(count(eligible));
    }) : [known(null)];
  } catch (error) {
    // No raw paths/errors in the API. Any partial collection remains unknown.
    result.quotas = [unknown]; result.cpusets = [unknown];
    console.warn("[cpu-capacity] constraint observation unavailable", error instanceof Error ? error.name : "unknown");
  }
  return result;
}
