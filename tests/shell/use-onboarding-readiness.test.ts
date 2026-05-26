import { describe, expect, it } from "vitest";
import { coerceOnboardingSteps, coerceReadinessGates, coerceReadinessOverallStatus, coerceReadinessResponse } from "@/hooks/useOnboarding";

describe("coerceReadinessGates", () => {
  it("filters malformed readiness gate records before UI rendering", () => {
    const gates = coerceReadinessGates([
      {
        id: "workspace.provisioned",
        category: "workspace",
        criticality: "release_critical",
        status: "pass",
        message: "Workspace is ready",
        remediation: null,
        owner: "matrix",
        lastCheckedAt: null,
      },
      { id: undefined, message: undefined, status: "pass" },
      { id: "bad", category: "workspace", criticality: "release_critical", status: "weird", message: "Bad", remediation: null, owner: "matrix", lastCheckedAt: null },
    ]);

    expect(gates).toEqual([
      expect.objectContaining({
        id: "workspace.provisioned",
        message: "Workspace is ready",
      }),
    ]);
  });
});

describe("coerceReadinessResponse", () => {
  it("normalizes malformed readiness responses before storing them", () => {
    const readiness = coerceReadinessResponse({
      overallStatus: "nonsense",
      goals: undefined,
      gates: "bad",
      systemAgent: "claude",
      activeAgents: undefined,
    });

    expect(readiness).toMatchObject({
      overallStatus: "degraded",
      goals: [],
      gates: [],
      systemAgent: "hermes",
      activeAgents: ["hermes"],
    });
  });
});

describe("coerceReadinessOverallStatus", () => {
  it("falls back when websocket readiness updates send malformed status values", () => {
    expect(coerceReadinessOverallStatus("ready")).toBe("ready");
    expect(coerceReadinessOverallStatus("unknown")).toBe("degraded");
    expect(coerceReadinessOverallStatus(undefined)).toBe("degraded");
  });
});

describe("coerceOnboardingSteps", () => {
  it("drops malformed setup steps before rendering", () => {
    expect(coerceOnboardingSteps([
      { id: "github.connected", required: true, title: "Connect GitHub", unlocks: ["coding"] },
      { id: "bad", required: "yes", title: "Bad", unlocks: [] },
    ])).toEqual([
      expect.objectContaining({ id: "github.connected" }),
    ]);
  });
});
