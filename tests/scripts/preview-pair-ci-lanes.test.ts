import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("requires the real preview-pair Electron journey after its production build in the native CI lane", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = workflow.jobs.e2e.steps;
  const build = steps.findIndex((step: { name?: string }) => step.name === "Build Desktop for Electron E2E");
  const journey = steps.findIndex((step: { run?: string }) => step.run?.includes("tests/e2e/desktop/preview-pair.e2e.test.ts"));
  expect(build).toBeGreaterThanOrEqual(0);
  expect(journey).toBeGreaterThan(build);
  expect(steps[journey].if).toBe(steps[build].if);
  expect(steps[journey].env.MATRIX_DESKTOP_E2E_REQUIRED).toBe("1");
  expect(steps[journey].run).toContain("xvfb-run --auto-servernum bun run test:e2e:run");
  expect(steps[journey].run).toContain("--maxWorkers=1");
  expect(steps[journey]["continue-on-error"]).not.toBe(true);
});
