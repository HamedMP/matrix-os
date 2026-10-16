import { describe, expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/index.js";

// Proposed shared contract for ENG-288. No test-side implementation/fallback:
// missing exports fail assertions, rather than preventing test collection.
type Observation<T> = { status: "known"; value: T } | { status: "unavailable" };
type CpuObservations = {
  visibleLogicalCpuCount: number;
  affinity: Observation<number>;
  // Every applicable ancestor must be observed, including explicit unlimited.
  cpusets: Observation<number | null>[];
  quotas: Observation<{ quotaMicros: number; periodMicros: number } | null>[];
};
type CpuCapacity = {
  visibleLogicalCpuCount: number;
  effectiveCpuCapacity: number | null;
  constraintStatus: "complete" | "unavailable";
};

const known = <T>(value: T): Observation<T> => ({ status: "known", value });
const unavailable = { status: "unavailable" } as const;
const quota = (cores: number) => known({ quotaMicros: cores * 100_000, periodMicros: 100_000 });
const baseline = (): CpuObservations => ({
  visibleLogicalCpuCount: 8,
  affinity: known(8),
  cpusets: [known(null)],
  quotas: [known(null)],
});

function derive(observations: CpuObservations): CpuCapacity {
  const exported = contracts as unknown as Record<string, unknown>;
  expect(exported.deriveCpuCapacity, "one shared deriveCpuCapacity export is required").toBeTypeOf("function");
  return (exported.deriveCpuCapacity as (input: CpuObservations) => CpuCapacity)(observations);
}

describe("ENG-288 shared CPU capacity derivation", () => {
  it.each([
    ["affinity only", { affinity: known(4) }, 4],
    ["cpuset only", { cpusets: [known(4)] }, 4],
    ["quota only", { quotas: [quota(4)] }, 4],
    ["tighter ancestor quota", { quotas: [quota(6), quota(2), known(null)] }, 2],
    ["tighter ancestor cpuset", { cpusets: [known(6), known(3), known(null)] }, 3],
    ["fractional quota", { quotas: [quota(1.5)] }, 1.5],
    ["sub-core quota", { quotas: [quota(0.5)] }, 0.5],
    ["combined constraints", { affinity: known(4), cpusets: [known(3)], quotas: [quota(2.5)] }, 2.5],
    ["explicitly unconstrained", {}, 8],
  ] satisfies Array<[string, Partial<CpuObservations>, number]>)("distinguishes topology from %s capacity", (_name, overrides, effective) => {
    expect(derive({ ...baseline(), ...overrides })).toEqual({
      visibleLogicalCpuCount: 8,
      effectiveCpuCapacity: effective,
      constraintStatus: "complete",
    });
  });

  it.each([
    ["affinity", { affinity: unavailable }],
    ["cpuset", { cpusets: [unavailable] }],
    ["quota", { quotas: [unavailable] }],
    ["ancestor quota", { quotas: [quota(4), unavailable] }],
    ["ancestor cpuset", { cpusets: [known(4), unavailable] }],
  ] satisfies Array<[string, Partial<CpuObservations>]>)("does not call unreadable %s constraints unlimited", (_name, overrides) => {
    expect(derive({ ...baseline(), ...overrides })).toEqual({
      visibleLogicalCpuCount: 8,
      effectiveCpuCapacity: null,
      constraintStatus: "unavailable",
    });
  });
});
