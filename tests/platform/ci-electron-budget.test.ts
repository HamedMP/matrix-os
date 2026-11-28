import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("budgets cold browser setup separately from required Electron regressions", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  // Run39854132831: browser installation alone took618s. Required Electron
  // cases were still running when the old15m job limit cancelled the lane.
  const coldSetupSeconds = 618;
  const requiredRegressionBudgetSeconds = 15 * 60;
  const cleanupSeconds = 120;
  expect(workflow.jobs.e2e["timeout-minutes"] * 60).toBeGreaterThanOrEqual(
    coldSetupSeconds + requiredRegressionBudgetSeconds + cleanupSeconds,
  );
  expect(workflow.jobs.e2e["timeout-minutes"]).toBeLessThanOrEqual(30);
});
