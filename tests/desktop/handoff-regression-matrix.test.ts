import { describe, expect, it } from "vitest";
import {
  HANDOFF_REGRESSION_MATRIX,
  assertHandoffMatrixCoverage,
  type HandoffRequirement,
  type HandoffSurface,
} from "../e2e/desktop/handoff-regression-matrix";

const SURFACES: HandoffSurface[] = ["navigation", "chat", "terminal", "files"];
const REQUIRED_PER_SURFACE: HandoffRequirement[] = [
  "first-load",
  "loading",
  "ready",
  "empty",
  "search-empty",
  "offline",
  "reconnecting",
  "error",
  "retry",
  "runtime-switch",
  "auth-replacement",
  "sign-out",
  "reconnect",
  "stale-live-resource",
  "light-theme",
  "dark-theme",
  "default-window",
  "narrow-window",
  "resize",
  "zoom",
  "keyboard-navigation",
  "focus-restoration",
  "screen-reader-names",
  "reduced-motion",
  "contrast",
  "long-content",
  "bounded-errors",
  "electron",
];

describe("Desktop handoff regression matrix", () => {
  it("covers every handoff surface and required cross-surface QA dimension", () => {
    expect(() => assertHandoffMatrixCoverage(HANDOFF_REGRESSION_MATRIX)).not.toThrow();

    for (const surface of SURFACES) {
      const covered = new Set(
        HANDOFF_REGRESSION_MATRIX
          .filter((scenario) => scenario.surface === surface)
          .flatMap((scenario) => scenario.requirements),
      );
      for (const requirement of REQUIRED_PER_SURFACE) {
        expect(covered.has(requirement), `${surface}:${requirement}`).toBe(true);
      }
    }
  });

  it("reports actionable missing coverage instead of silently accepting a partial matrix", () => {
    const withoutFiles = HANDOFF_REGRESSION_MATRIX.filter(
      (scenario) => scenario.surface !== "files",
    );

    expect(() => assertHandoffMatrixCoverage(withoutFiles)).toThrow(
      /surface:files/,
    );
  });

  it("keeps blocked feature semantics assigned to their owning dependency", () => {
    const dependencyOwners = new Set(
      HANDOFF_REGRESSION_MATRIX
        .filter((scenario) => scenario.execution === "dependency")
        .map((scenario) => scenario.owner),
    );

    expect(dependencyOwners).toEqual(
      new Set(["MAT-298", "MAT-299", "MAT-300", "MAT-301"]),
    );
    expect(
      HANDOFF_REGRESSION_MATRIX.some((scenario) => scenario.owner === "MAT-268"),
    ).toBe(false);
  });
});
