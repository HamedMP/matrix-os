import { describe, expect, it } from "vitest";
import { coerceReadinessGates } from "@/hooks/useOnboarding";

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
