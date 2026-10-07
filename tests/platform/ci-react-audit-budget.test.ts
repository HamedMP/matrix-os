import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("budgets React auditing for observed checkout time plus audit and cleanup margin", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
    jobs: { "react-doctor": { "timeout-minutes": number } };
  };
  // Run37537351643: checkout315s + successful audit49s exceeded the old6m
  // job budget during cleanup. Keep two minutes beyond the observed work.
  const observedCheckoutSeconds = 315;
  const observedAuditSeconds = 49;
  const cleanupAndVarianceSeconds = 120;
  const budgetSeconds = workflow.jobs["react-doctor"]["timeout-minutes"] * 60;
  expect(Number.isFinite(budgetSeconds)).toBe(true);
  expect(budgetSeconds).toBeGreaterThanOrEqual(observedCheckoutSeconds + observedAuditSeconds + cleanupAndVarianceSeconds);
});
