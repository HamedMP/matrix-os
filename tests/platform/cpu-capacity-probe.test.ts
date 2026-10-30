import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "undici";
import { probeCustomerVpsRuntime } from "../../packages/platform/src/runtime-probes.js";

afterEach(() => vi.unstubAllGlobals());
const capacity = { visibleLogicalCpuCount: 8, effectiveCpuCapacity: 1.5, constraintStatus: "complete" };
describe("ENG-288 platform runtime CPU provenance", () => {
  it.each([
    ["new gateway", capacity, capacity],
    ["older gateway", undefined, null],
    ["invalid effective value", { ...capacity, effectiveCpuCapacity: 9 }, null],
    ["unknown constraints", { ...capacity, effectiveCpuCapacity: null, constraintStatus: "unavailable" }, { ...capacity, effectiveCpuCapacity: null, constraintStatus: "unavailable" }],
  ])("forwards validated provenance for %s without plan inference", async (_name, observation, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ resources: { cpuCount: 8, cpuCapacity: observation } }))));
    const result = await probeCustomerVpsRuntime({ handle: "cpu-fixture", publicIPv4: "192.0.2.1" }, "fixture-platform-secret", {} as Agent);
    expect(result.cpuCount).toBe(8);
    expect((result as unknown as Record<string, unknown>).cpuCapacity).toEqual(expected);
  });
});
