import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contracts from "@matrix-os/contracts";

const constraints = vi.hoisted(() => ({
  "/proc/self/cgroup": "0::/\n",
  "/proc/self/status": "Cpus_allowed_list:\t0-3\n",
  "/proc/self/mountinfo": "31 23 0:28 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n",
  "/sys/fs/cgroup/cpu.max": "max 100000\n",
  "/sys/fs/cgroup/cpuset.cpus": "0-3\n",
  "/sys/fs/cgroup/cpuset.cpus.effective": "0-3\n",
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
      const fixture = constraints[String(path) as keyof typeof constraints];
      if (fixture !== undefined) return fixture;
      return Reflect.apply(fs.readFileSync, fs, [path, ...args]);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: async (path: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      const fixture = constraints[String(path) as keyof typeof constraints];
      if (fixture !== undefined) return fixture;
      return Reflect.apply(fs.readFile, fs, [path, ...args]);
    },
  };
});

vi.mock("@matrix-os/kernel", () => ({
  loadSkills: () => [],
  resolveKernelConfigFile: () => ({ model: "fixture", effort: "low" }),
}));
vi.mock("../../packages/gateway/src/collaboration/config.js", () => ({
  describeGatewayCollaborationConfiguration: () => ({ configured: false }),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  cpus: () => Array.from({ length: 8 }, () => ({ model: "fixture", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
  availableParallelism: () => 4,
}));

// Process fixtures, not customer observations. Keep collection local and bounded.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({ stdout: "", stderr: "" }) });
  return { execFile };
});

import { getSystemInfo } from "../../packages/gateway/src/system-info.js";
import { collectSystemActivity } from "../../packages/gateway/src/system-activity/collector.js";
import { CleanupCandidateRegistry } from "../../packages/gateway/src/system-activity/cleanup.js";

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  vi.restoreAllMocks();
});

describe("ENG-288 system info and activity CPU projections", () => {
  it("uses the authoritative shared derivation rather than recounting in activity", async () => {
    const shared = contracts as unknown as { deriveCpuCapacity: (...args: unknown[]) => unknown };
    expect(shared.deriveCpuCapacity, "the gateway must consume the shared contract").toBeTypeOf("function");
    const derivation = vi.spyOn(shared, "deriveCpuCapacity");
    home = mkdtempSync(join(tmpdir(), "eng-288-shared-"));
    getSystemInfo(home);
    expect(derivation).toHaveBeenCalledTimes(1);
    await collectSystemActivity({
      homePath: home,
      collectOptions: { processLimit: 1, includeSuggestions: false },
      candidates: new CleanupCandidateRegistry(),
    });
    // Activity already asks getSystemInfo for a snapshot; reuse its CPU result.
    expect(derivation).toHaveBeenCalledTimes(2);
  });

  it("publishes the same explicit capacity observation in both live projections", async () => {
    home = mkdtempSync(join(tmpdir(), "eng-288-"));
    const info = getSystemInfo(home);
    const activity = await collectSystemActivity({
      homePath: home,
      collectOptions: { processLimit: 1, includeSuggestions: false },
      candidates: new CleanupCandidateRegistry(),
    });
    const infoResources = info.resources as unknown as Record<string, unknown>;
    const activityCpu = activity.resources.cpu as unknown as Record<string, unknown>;
    // A new observation must be additive: legacy count still means topology.
    expect(info.resources.cpuCount).toBe(8);
    expect(activity.resources.cpu.cores).toBe(8);
    expect(infoResources.cpuCapacity).toEqual({
      visibleLogicalCpuCount: 8,
      effectiveCpuCapacity: 4,
      constraintStatus: "complete",
    });
    expect(activityCpu.capacity).toEqual(infoResources.cpuCapacity);
  });
});
