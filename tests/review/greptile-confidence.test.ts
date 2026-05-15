import { describe, expect, it } from "vitest";
import {
  findLatestGreptileConfidenceScore,
  isTrustedGreptileAuthor,
  parseConfidenceScore,
} from "../../scripts/review/check-greptile-confidence.mjs";

describe("Greptile confidence check", () => {
  it("parses confidence scores from review text", () => {
    expect(parseConfidenceScore("Confidence Score: 5/5")).toBe(5);
    expect(parseConfidenceScore("confidence score: 3 / 5")).toBe(3);
    expect(parseConfidenceScore("no score here")).toBeNull();
  });

  it("only trusts Greptile-authored comments", () => {
    expect(isTrustedGreptileAuthor({ login: "greptile-app[bot]" })).toBe(true);
    expect(isTrustedGreptileAuthor({ login: "HamedMP" })).toBe(false);
  });

  it("ignores user-quoted scores and returns the latest trusted Greptile score", () => {
    const latest = findLatestGreptileConfidenceScore([
      {
        body: "Confidence Score: 5/5",
        author: { login: "HamedMP" },
        source: "issue_comment",
        updatedAt: "2026-05-15T13:00:00.000Z",
      },
      {
        body: "Confidence Score: 3/5",
        author: { login: "greptile-app[bot]" },
        source: "pull_review",
        updatedAt: "2026-05-15T12:00:00.000Z",
      },
      {
        body: "Confidence Score: 5/5",
        author: { login: "greptile-app[bot]" },
        source: "pull_review",
        updatedAt: "2026-05-15T14:00:00.000Z",
      },
    ]);

    expect(latest).toMatchObject({
      score: 5,
      author: "greptile-app[bot]",
      source: "pull_review",
    });
  });
});
