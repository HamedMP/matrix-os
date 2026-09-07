import { describe, expect, it } from "vitest";
import { findRecentSystemErrorMessage } from "../../shell/src/components/vocal-panel-approval-guard.js";

describe("findRecentSystemErrorMessage", () => {
  it("returns the most recent plain system message as the error", () => {
    const messages = [
      { role: "user", content: "build me a todo app" },
      { role: "assistant", content: "on it" },
      { role: "system", content: "kernel: sandbox write denied" },
    ];

    expect(findRecentSystemErrorMessage(messages, 0)).toBe("kernel: sandbox write denied");
  });

  it("skips a system message carrying approval metadata and keeps looking", () => {
    const messages = [
      { role: "user", content: "build me a todo app" },
      { role: "system", content: "kernel: sandbox write denied" },
      {
        role: "system",
        content: "Allow the command: write outside the sandboxed workspace root.",
        metadata: { canonicalApproval: { approvalId: "appr_1", pending: true } },
      },
    ];

    expect(findRecentSystemErrorMessage(messages, 0)).toBe("kernel: sandbox write denied");
  });

  it("returns undefined when the only system message in range is an approval card", () => {
    const messages = [
      { role: "user", content: "build me a todo app" },
      {
        role: "system",
        content: "Allow the command: write outside the sandboxed workspace root.",
        metadata: { canonicalApproval: { approvalId: "appr_1", pending: false } },
      },
    ];

    expect(findRecentSystemErrorMessage(messages, 0)).toBeUndefined();
  });

  it("respects startIdx and ignores messages before the delegation window", () => {
    const messages = [
      { role: "system", content: "stale error from a previous delegation" },
      { role: "user", content: "build me a todo app" },
      { role: "assistant", content: "on it" },
    ];

    expect(findRecentSystemErrorMessage(messages, 1)).toBeUndefined();
  });
});
