import { describe, expect, it } from "vitest";
import { classifiedClaudeFailureEvidence } from "../../packages/gateway/src/chat/claude-run-failure.js";
import { canonicalChatSafeFailureReason } from "@matrix-os/contracts";

describe("Claude actionable terminal failures", () => {
  it.each([
    ["Authentication required. Run /login. secret=private", "authentication"],
    ["Credit balance is too low /home/private token=secret", "credit"],
    ["Your credit balance is too low. Please add credits.", "credit"],
  ])("keeps %s private and displays its reviewed cause", (text, category) => {
    const failure = classifiedClaudeFailureEvidence(text);
    expect(failure?.category).toBe(category);
    expect(failure?.safeError.retryable).toBe(false);
    expect(canonicalChatSafeFailureReason(failure?.safeError.code, failure?.safeError.safeMessage))
      .toBe(failure?.safeError.safeMessage);
    expect(JSON.stringify(failure)).not.toMatch(/private|token=|secret=|credits\./);
  });
  it.each(["Unknown upstream error", "The user asks about insufficient credits", "", "A tool reports credit balance is too low"])(
    "does not invent a funding explanation from ambiguous text: %s", (text) => {
      expect(classifiedClaudeFailureEvidence(text)).toBeUndefined();
    },
  );
});
