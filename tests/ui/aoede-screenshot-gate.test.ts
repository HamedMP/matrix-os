import { describe, expect, it } from "vitest";
import { fixtureProblems } from "../../scripts/aoede-fixture-screenshots.js";

const valid = { ready: "true", launcher: true, host: true, chatDom: false, schemaIssues: "0",
  speechSeam: "fake", canonicalSeam: "fake" };
describe("Aoede rendered fixture evidence gate", () => {
  it("accepts a settled Chat-free host with zero schema issues", () => {
    expect(fixtureProblems(valid, false)).toEqual([]);
    expect(fixtureProblems({ ...valid, host: false }, true)).toEqual([]);
  });
  it("requires both fake seam identities, not a descriptive boundary label", () => {
    expect(fixtureProblems({ ...valid, speechSeam: "managed" }, false)).toContain("speech seam is not fake");
    expect(fixtureProblems({ ...valid, canonicalSeam: null }, false)).toContain("canonical provider seam is not fake");
  });
  it("rejects nonzero or missing schema counts rather than finding the label", () => {
    expect(fixtureProblems({ ...valid, schemaIssues: "2" }, false)).toContain("fixture schema validation failed");
    expect(fixtureProblems({ ...valid, schemaIssues: null }, false)).toContain("fixture schema validation failed");
  });
  it("rejects unsettled drivers, missing panels, and mounted Chat", () => {
    expect(fixtureProblems({ ...valid, ready: "pending" }, false)).toContain("driver did not settle successfully");
    expect(fixtureProblems({ ...valid, ready: "error" }, false)).toContain("driver did not settle successfully");
    expect(fixtureProblems({ ...valid, host: false }, false)).toContain("standalone host visibility mismatch");
    expect(fixtureProblems({ ...valid, chatDom: true }, false)).toContain("Chat DOM marker detected — fixture must never render Chat");
  });
});
