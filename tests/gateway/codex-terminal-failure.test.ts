import { describe, expect, it } from "vitest";
import { codexTerminalFailureReason } from "../../packages/gateway/src/coding-agents/codex-terminal-failure.mjs";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

describe("Codex terminal failure classification", () => {
  it.each([
    [{ codexErrorInfo: "unauthorized" }, "authentication_required"],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, "authentication_required"],
    [{ message: "workspace routing discovery unauthorized (401)" }, "authentication_required"],
    [{ message: "Your access token could not be refreshed because your refresh token was revoked." }, "authentication_required"],
    [{ codexErrorInfo: "usageLimitExceeded" }, "usage_limit"],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } } }, "billing_required"],
  ])("classifies a native terminal error without copying its text: %#", (error, expected) => {
    expect(codexTerminalFailureReason(error)).toBe(expected);
  });
  it.each([
    undefined, null, "unauthorized", { message: "A tool says unauthorized" },
    { codexErrorInfo: "rateLimitExceeded" }, { codexErrorInfo: "sessionBudgetExceeded" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } },
    { message: `workspace routing discovery unauthorized (401)${"x".repeat(4096)}` },
    { failureReason: "authentication_required" },
  ])("keeps unknown or ambiguous evidence generic: %#", (error) => {
    expect(codexTerminalFailureReason(error)).toBeUndefined();
  });
  it("preserves only a reviewed reason in a durable failed-turn record", () => {
    const result = parseCodexExecJsonLine(JSON.stringify({ type: "turn.failed", failureReason: "authentication_required" }), {
      threadId: "thread_failure", now: () => new Date("2026-10-05T09:05:57Z"), nextEventId: () => "evt_failure",
    });
    expect(result).toMatchObject({ outcome: "failed", failureReason: "authentication_required" });
    const ignored = parseCodexExecJsonLine(JSON.stringify({ type: "turn.failed", failureReason: "bearer secret /home/private" }), {
      threadId: "thread_failure", now: () => new Date(), nextEventId: () => "evt_failure",
    });
    expect(ignored).toEqual({ events: [], outcome: "failed" });
  });
  it("classifies legacy exec terminal error metadata without publishing the raw error", () => {
    const result = parseCodexExecJsonLine(JSON.stringify({ type: "turn.failed", error: {
      message: "workspace routing discovery unauthorized (401) bearer private /home/private",
    } }), { threadId: "thread_failure", now: () => new Date(), nextEventId: () => "evt_failure" });
    expect(result).toEqual({ events: [], outcome: "failed", failureReason: "authentication_required" });
  });
});
