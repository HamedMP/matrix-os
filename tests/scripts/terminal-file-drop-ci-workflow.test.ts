import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("requires built Electron attachment tests after the Desktop build in CI", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = workflow.jobs.e2e.steps as Array<{ run?: string; env?: Record<string, string> }>;
  const build = steps.findIndex((step) => step.run === "bun run build:desktop");
  const regression = steps.findIndex((step) => step.run?.includes("tests/e2e/desktop/terminal-file-drop.e2e.test.ts"));
  expect(build).toBeGreaterThan(-1);
  expect(regression).toBeGreaterThan(build);
  expect(steps[regression]?.env?.MATRIX_DESKTOP_E2E_REQUIRED).toBe("1");
});
