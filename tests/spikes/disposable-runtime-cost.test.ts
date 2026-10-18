import { describe, expect, it } from "vitest";
import {
  vpsCost, poolCost, cloudRunCost, lambdaCost, cloudflareCost, scenarios,
} from "../../scripts/spikes/disposable-runtime/cost-model.mjs";

describe("disposable runtime cost assumptions", () => {
  it("rounds each VPS creation separately and caps each server within one billing month", () => {
    expect(vpsCost([0.01, 0.01], 0.0104, 6.49)).toEqual({ billedHours: 2, usd: 0.0208 });
    expect(vpsCost([744], 0.0104, 6.49).usd).toBe(6.49);
    expect(vpsCost([744, 744], 0.0104, 6.49).usd).toBe(12.98);
    expect(vpsCost([], 0.0104, 6.49)).toEqual({ billedHours: 0, usd: 0 });
  });

  const pool = {
    hostMemoryGiB: 8, reservedMemoryGiB: 1, runtimeMemoryGiB: 2,
    hostVcpu: 4, reservedVcpu: 1, runtimeVcpuBudget: 1,
    monthlyHostUsd: 10, monthHours: 730, targetOccupancy: 0.5,
    residentHours: 100, peakConcurrent: 1, minHosts: 1,
  };
  it("uses finite concurrent slots and includes the paid baseline even at low occupancy", () => {
    const result = poolCost(pool);
    expect(result.slotsPerHost).toBe(3);
    expect(result.hosts).toBe(1);
    expect(result.usd).toBe(10);
    expect(result.occupancy).toBeCloseTo(100 / 2190);
    expect(result.usdPerResidentHour).toBe(0.1);
    expect(poolCost({ ...pool, residentHours: 0, peakConcurrent: 0 }).usd).toBe(10);
  });
  it("sizes hosts for both workload volume and explicit simultaneous demand", () => {
    expect(poolCost({ ...pool, residentHours: 3000 }).hosts).toBe(3);
    expect(poolCost({ ...pool, peakConcurrent: 7 }).hosts).toBe(3);
    expect(poolCost({ ...pool, runtimeVcpuBudget: 2 }).slotsPerHost).toBe(1);
  });
  it("charges Cloud Run allocated resources and enforces the instance minimum", () => {
    expect(cloudRunCost({ mode: "request", sessions: 2, secondsPerSession: 1.01,
      memoryGiB: 2, vcpu: 1 }).billedSeconds).toBeCloseTo(2.2);
    expect(cloudRunCost({ mode: "instance", sessions: 2, secondsPerSession: 1,
      memoryGiB: 2, vcpu: 1 }).billedSeconds).toBe(120);
    expect(cloudRunCost({ mode: "instance", sessions: 1, secondsPerSession: 3600,
      memoryGiB: 2, vcpu: 1 }).usd).toBeCloseTo(0.0792);
  });
  it("charges Lambda millisecond memory duration, requests, and excess scratch storage", () => {
    const result = lambdaCost({ invocations: 2, secondsPerInvocation: 0.0011,
      memoryGiB: 2, scratchGiB: 1 });
    expect(result.billedSeconds).toBe(0.004);
    expect(result.usd).toBeCloseTo(0.004 * 2 * 0.0000166667 + 0.0000004 + 0.004 * 0.5 * 0.0000000309);
    expect(() => lambdaCost({ invocations: 1, secondsPerInvocation: 901,
      memoryGiB: 2, scratchGiB: 0.5 })).toThrow();
  });
  it("charges Cloudflare actual CPU but provisioned RAM/disk including idle resident time", () => {
    const result = cloudflareCost({ sessions: 1, secondsPerSession: 3600,
      cpuSecondsPerSession: 720, memoryGiB: 2, diskGB: 4 });
    expect(result.usd).toBeCloseTo(720 * 0.00002 + 7200 * 0.0000025 + 14400 * 0.00000007);
    expect(result.billedSeconds).toBe(3600);
  });
  it("rejects non-finite, negative, fractional counts and impossible capacity", () => {
    for (const value of [NaN, Infinity, -1]) {
      expect(() => vpsCost([value], 0.1, 10)).toThrow();
      expect(() => poolCost({ ...pool, residentHours: value })).toThrow();
      expect(() => cloudflareCost({ sessions: 1, secondsPerSession: value,
        cpuSecondsPerSession: 0, memoryGiB: 2, diskGB: 4 })).toThrow();
    }
    expect(() => vpsCost([745], 0.1, 10)).toThrow();
    expect(() => poolCost({ ...pool, runtimeMemoryGiB: 9 })).toThrow();
    expect(() => poolCost({ ...pool, targetOccupancy: 0 })).toThrow();
    expect(() => poolCost({ ...pool, targetOccupancy: 1.1 })).toThrow();
    expect(() => poolCost({ ...pool, residentHours: undefined })).toThrow();
    const { residentHours: _residentHours, ...incompletePool } = pool;
    expect(() => poolCost(incompletePool)).toThrow();
    expect(() => cloudRunCost({ mode: "unknown", sessions: 1,
      secondsPerSession: 1, memoryGiB: 2, vcpu: 1 })).toThrow();
    expect(() => lambdaCost({ invocations: 1.5, secondsPerInvocation: 1,
      memoryGiB: 2, scratchGiB: 0.5 })).toThrow();
  });
  it("labels costs as modeled and shows explicit workload, idle and fleet assumptions", () => {
    const output = scenarios();
    expect(output.kind).toBe("illustrative-cost-model-not-provider-benchmark");
    expect(output.plans.free.workHours).toBeCloseTo(20 * 5 / 60);
    expect(output.plans.starter.workHours).toBe(20);
    expect(output.plans.free.residentHours).toBeGreaterThan(output.plans.free.workHours);
    expect(output.plans.starter.lambda.compatibleUnsplit).toBe(false);
    expect(output.plans.free.fleets[0].accounts).toBe(10);
    expect(output.plans.free.fleets[0].pool.usd).toBeGreaterThan(0);
  });
});
