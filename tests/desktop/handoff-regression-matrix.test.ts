import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("documents every handoff dimension with an explicit verification disposition", () => {
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

    for (const scenario of HANDOFF_REGRESSION_MATRIX) {
      if (scenario.verification === "automated") {
        expect(scenario.evidence.length, scenario.id).toBeGreaterThan(0);
        for (const evidence of scenario.evidence) {
          const source = readFileSync(resolve(evidence.file), "utf8");
          expect(source, `${scenario.id}:${evidence.testName}`).toContain(
            `it("${evidence.testName}"`,
          );
        }
      } else {
        expect(scenario.note.trim().length, scenario.id).toBeGreaterThan(0);
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

  it("records the omitted OS View Terminal search state as deferred", () => {
    const terminalSearchScenarios = HANDOFF_REGRESSION_MATRIX.filter(
      (scenario) => scenario.surface === "terminal" && scenario.requirements.includes("search-empty"),
    );

    expect(terminalSearchScenarios).toHaveLength(1);
    expect(terminalSearchScenarios[0]).toMatchObject({
      id: "terminal-search-empty",
      verification: "deferred",
      note: expect.stringMatching(/intentionally omits search/i),
    });
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
