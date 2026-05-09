import { describe, it, expect } from "vitest";
import { buildFleetSummary, type FleetMachineView } from "../../packages/platform/src/customer-vps-fleet.js";

describe("customer-vps-fleet", () => {
  it("builds fleet summary with correct status counts and version distribution", () => {
    const machines: FleetMachineView[] = [
      makeMachine({ status: "running", imageVersion: "v2026.05.06-1", healthy: true }),
      makeMachine({ status: "running", imageVersion: "v2026.05.06-1", healthy: true }),
      makeMachine({ status: "running", imageVersion: "v2026.05.07-1", healthy: false }),
      makeMachine({ status: "provisioning", imageVersion: null, healthy: false }),
      makeMachine({ status: "failed", imageVersion: "v2026.05.05-1", healthy: false }),
    ];

    const summary = buildFleetSummary(machines);

    expect(summary.total).toBe(5);
    expect(summary.running).toBe(3);
    expect(summary.provisioning).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.healthSummary.healthy).toBe(2);
    expect(summary.healthSummary.degraded).toBe(1);
    expect(summary.healthSummary.unreachable).toBe(2);
    expect(summary.versionDistribution).toEqual({
      "v2026.05.06-1": 2,
      "v2026.05.07-1": 1,
      "v2026.05.05-1": 1,
      "unknown": 1,
    });
  });

  it("returns zeroes for empty fleet", () => {
    const summary = buildFleetSummary([]);

    expect(summary.total).toBe(0);
    expect(summary.running).toBe(0);
    expect(summary.provisioning).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.healthSummary).toEqual({ healthy: 0, degraded: 0, unreachable: 0 });
    expect(summary.versionDistribution).toEqual({});
  });

  it("handles failed machines in the summary", () => {
    const machines: FleetMachineView[] = [
      makeMachine({ status: "failed", imageVersion: "v2026.05.06-1", healthy: false }),
      makeMachine({ status: "running", imageVersion: "v2026.05.06-1", healthy: true }),
    ];

    const summary = buildFleetSummary(machines);

    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.running).toBe(1);
  });
});

function makeMachine(overrides: {
  status: "running" | "provisioning" | "failed" | "deleted" | "recovering";
  imageVersion: string | null;
  healthy: boolean;
}): FleetMachineView {
  return {
    machineId: crypto.randomUUID(),
    clerkUserId: "user_test",
    handle: "test",
    status: overrides.status,
    imageVersion: overrides.imageVersion,
    publicIPv4: "1.2.3.4",
    publicIPv6: null,
    provisionedAt: "2026-05-01T00:00:00Z",
    lastSeenAt: "2026-05-08T00:00:00Z",
    deletedAt: null,
    failureCode: null,
    failureAt: null,
    healthy: overrides.healthy,
  };
}
