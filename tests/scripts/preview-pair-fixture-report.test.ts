import { expect, it } from "vitest";
import { collectPreviewFixtureReport, PREVIEW_FIXTURE_FILES } from "../../scripts/preview-pair/qualify-fixtures.js";
function report() { return { success: true, numTotalTests: PREVIEW_FIXTURE_FILES.length, numPassedTests: PREVIEW_FIXTURE_FILES.length, numPendingTests: 0, numFailedTests: 0,
  testResults: PREVIEW_FIXTURE_FILES.map(name => ({ name: `/fixture/${name}`, assertionResults: [{ status: "passed" }] })) }; }
it("labels every complete fixture assertion as fixture-only and leaves product acceptance unrun", () => {
  expect(collectPreviewFixtureReport("/fixture", report())).toMatchObject({ assertions: PREVIEW_FIXTURE_FILES.length, boundary: "fixture", productAcceptance: "not_run" });
});
it.each(["missing", "empty", "skip", "foreign", "duplicate", "totals"])("rejects %s collection rather than silently qualifying it", fault => {
  const value = report();
  if (fault === "missing") value.testResults.pop();
  if (fault === "empty") value.testResults[0].assertionResults = [];
  if (fault === "skip") value.testResults[0].assertionResults[0].status = "pending";
  if (fault === "foreign") value.testResults[0].name = "/fixture/tests/unrelated.test.ts";
  if (fault === "duplicate") value.testResults[0] = value.testResults[1];
  if (fault === "totals") value.numPassedTests++;
  expect(() => collectPreviewFixtureReport("/fixture", value)).toThrow();
});
