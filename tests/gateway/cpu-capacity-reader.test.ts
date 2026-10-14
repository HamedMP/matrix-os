import { describe, expect, it } from "vitest";
import * as reader from "../../packages/gateway/src/cpu-capacity.js";
import { deriveCpuCapacity } from "../../packages/contracts/src/cpu-capacity.js";

function fixture(overrides: Record<string, string | Error> = {}) {
  const files: Record<string, string | Error> = {
    "/proc/self/status": "Cpus_allowed_list:\t0-7\n",
    "/proc/self/cgroup": "0::/tenant/task\n",
    "/proc/self/mountinfo": "31 23 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
    ...Object.fromEntries(["", "/tenant", "/tenant/task"].flatMap(path => [
      [`/sys/fs/cgroup${path}/cpu.max`, "max 100000\n"],
      [`/sys/fs/cgroup${path}/cpuset.cpus.effective`, "0-7\n"],
    ])),
    ...overrides,
  };
  return (path: string) => {
    const value = files[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw Object.assign(new Error("unavailable fixture"), { code: "ENOENT" });
    return value;
  };
}

function capacity(overrides: Record<string, string | Error> = {}) {
  return deriveCpuCapacity(reader.readCpuObservations({
    visibleLogicalCpuCount: 8, platform: "linux", readText: fixture(overrides),
  }));
}

describe("ENG-288 Linux CPU constraint collection", () => {
  it("honors a fractional ancestor quota even when the leaf is unlimited", () => {
    expect(capacity({ "/sys/fs/cgroup/tenant/cpu.max": "150000 100000\n" }).effectiveCpuCapacity).toBe(1.5);
  });
  it("intersects non-contiguous cpuset IDs with affinity", () => {
    expect(capacity({
      "/proc/self/status": "Cpus_allowed_list:\t0-3\n",
      "/sys/fs/cgroup/tenant/task/cpuset.cpus.effective": "2-5\n",
    }).effectiveCpuCapacity).toBe(2);
  });
  it.each([
    ["unreadable ancestor", { "/sys/fs/cgroup/tenant/cpu.max": new Error("denied") }],
    ["malformed quota", { "/sys/fs/cgroup/tenant/cpu.max": "max 0" }],
    ["malformed membership", { "/proc/self/cgroup": "unparseable" }],
    ["malformed affinity", { "/proc/self/status": "Cpus_allowed_list:\tbad\n" }],
    ["oversized record", { "/sys/fs/cgroup/tenant/cpu.max": "0".repeat(65_537) }],
    ["hidden ancestry", { "/proc/self/mountinfo": "31 23 0:28 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n" }],
    ["escaping membership", { "/proc/self/cgroup": "0::/../../escape\n" }],
  ] as const)("reports unknown for %s", (_name, overrides) => {
    expect(capacity(overrides)).toEqual({ visibleLogicalCpuCount: 8, effectiveCpuCapacity: null, constraintStatus: "unavailable" });
  });
  it("bounds ancestor traversal instead of returning a leaf-only estimate", () => {
    const group = "/" + Array.from({ length: 65 }, () => "child").join("/");
    expect(capacity({ "/proc/self/cgroup": `0::${group}\n` }).effectiveCpuCapacity).toBeNull();
  });

  it("reads cgroup v1 quota and inherited cpuset controllers", () => {
    const readText = fixture({
      "/proc/self/cgroup": "2:cpu,cpuacct:/tenant\n3:cpuset:/tenant\n",
      "/proc/self/mountinfo": "31 23 0:28 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n32 23 0:29 / /sys/fs/cgroup/cpuset rw - cgroup cgroup rw,cpuset\n",
      "/sys/fs/cgroup/cpu/tenant/cpu.cfs_quota_us": "50000",
      "/sys/fs/cgroup/cpu/tenant/cpu.cfs_period_us": "100000",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      "/sys/fs/cgroup/cpuset/tenant/cpuset.cpus": "",
      "/sys/fs/cgroup/cpuset/cpuset.cpus": "0-7",
    });
    expect(deriveCpuCapacity(reader.readCpuObservations({ visibleLogicalCpuCount: 8, platform: "linux", readText })).effectiveCpuCapacity).toBe(0.5);
  });
});
