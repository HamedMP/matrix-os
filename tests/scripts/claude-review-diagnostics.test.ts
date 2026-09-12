import { describe, expect, it } from "vitest";
import { classifyReviewFailure } from "../../scripts/ci/claude-review-diagnostics.mjs";

describe("safe Claude review failure diagnostics", () => {
  it.each([
    ["OAuth token has expired. Please obtain a new token.", "authentication"],
    ["Your credit balance is too low", "billing_or_quota"],
    ["The model claude-invalid was not found", "model_unavailable"],
    ["ECONNRESET", "network"],
    ["permission denied", "permissions"],
  ])("classifies %s", (message, expected) => {
    expect(classifyReviewFailure([{ type: "result", is_error: true, errors: [message] }])).toBe(expected);
  });
  it("does not inspect unrelated transcript text or expose secrets", () => {
    expect(classifyReviewFailure([{ type: "assistant", message: "OAuth token expired" }, { type: "result", is_error: true, errors: ["private@example.com /private/path secret-token"] }])).toBe("unclassified");
  });
});
