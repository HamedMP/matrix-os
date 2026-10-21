import { describe, expect, it } from "vitest";
import { classifiedClaudeCliFailure, classifiedClaudeFailureEvidence } from "../../packages/gateway/src/chat/claude-run-failure.js";
import { canonicalChatSafeFailureReason } from "@matrix-os/contracts";
import { CanonicalCliError } from "../../packages/gateway/src/chat/cli-process.js";

describe("Claude actionable terminal failures", () => {
  it("requires checking progress after a typed local execution deadline", () => {
    expect(classifiedClaudeCliFailure(new CanonicalCliError("timeout"))?.safeError).toEqual({
      code: "run_failed", safeMessage: "The agent timed out. Check progress before trying again.",
      retryable: false, recoveryActions: [],
    });
  });
  it.each([
    ["Authentication required. Run /login. secret=private", "authentication"],
    ["Credit balance is too low /home/private token=secret", "credit"],
    ["Your credit balance is too low. Please add credits.", "credit"],
    ["Prompt is too long token=private", "context_limit"],
  ])("keeps %s private and displays its reviewed cause", (text, category) => {
    const failure = classifiedClaudeFailureEvidence(text);
    expect(failure?.category).toBe(category);
    expect(failure?.safeError.retryable).toBe(false);
    expect(canonicalChatSafeFailureReason(failure?.safeError.code, failure?.safeError.safeMessage))
      .toBe(failure?.safeError.safeMessage);
    expect(JSON.stringify(failure)).not.toMatch(/private|token=|secret=|credits\./);
  });
  it("does not trust untyped objects or error prose as local timeout evidence", () => {
    expect(classifiedClaudeCliFailure({ kind: "timeout" })).toBeUndefined();
    expect(classifiedClaudeCliFailure(new Error("Provider CLI Run timed out"))).toBeUndefined();
  });
  it.each(["Unknown upstream error", "The user asks about insufficient credits", "", "A tool reports credit balance is too low", "The user asks about prompt is too long"])(
    "does not invent a funding explanation from ambiguous text: %s", (text) => {
      expect(classifiedClaudeFailureEvidence(text)).toBeUndefined();
    },
  );
});
