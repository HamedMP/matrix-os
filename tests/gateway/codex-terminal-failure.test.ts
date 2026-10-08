import { describe, expect, it } from "vitest";
import { CodexExecutionTimeout, codexExecutionFailureReason, codexTerminalFailureReason } from "../../packages/gateway/src/coding-agents/codex-terminal-failure.mjs";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

describe("Codex terminal failure classification", () => {
  it("requires a typed local deadline rather than an upstream claim of timeout", () => {
    expect(codexExecutionFailureReason(new CodexExecutionTimeout())).toBe("execution_timeout");
    expect(codexExecutionFailureReason(new Error("Coding execution deadline exceeded"))).toBeUndefined();
    expect(codexExecutionFailureReason({ name: "CodexExecutionTimeout" })).toBeUndefined();
  });
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
    ["contextWindowExceeded", "context_limit"], ["sessionBudgetExceeded", "session_budget"],
    ["serverOverloaded", "service_busy"], ["internalServerError", "service_failed"],
    ["cyberPolicy", "policy_blocked"], ["badRequest", "invalid_request"],
    ["sandboxError", "environment_failed"], ["threadRollbackFailed", "history_unavailable"],
    [{ httpConnectionFailed: { httpStatusCode: 403 } }, "permission_denied"],
    [{ httpConnectionFailed: { httpStatusCode: 429 } }, "rate_limited"],
    [{ httpConnectionFailed: { httpStatusCode: 408 } }, "request_timeout"],
    [{ httpConnectionFailed: { httpStatusCode: 503 } }, "service_busy"],
    [{ httpConnectionFailed: { httpStatusCode: 500 } }, "service_failed"],
    [{ responseStreamConnectionFailed: { httpStatusCode: null } }, "connection_failed"],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, "connection_failed"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 504 } }, "request_timeout"],
  ])("distinguishes terminal structured cause %#", (codexErrorInfo, expected) => {
    expect(codexTerminalFailureReason({ codexErrorInfo, message: "bearer private /home/private" })).toBe(expected);
    const durable = parseCodexExecJsonLine(JSON.stringify({ type: "turn.failed", failureReason: expected }), {
      threadId: "thread_failure", now: () => new Date(), nextEventId: () => "evt_failure",
    });
    expect(durable).toEqual({ events: [], outcome: "failed", failureReason: expected });
  });
  it.each([
    undefined, null, "unauthorized", { message: "A tool says unauthorized" },
    { codexErrorInfo: "rateLimitExceeded" }, { codexErrorInfo: "futureUnknownError" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: "403" } } },
    { message: `workspace routing discovery unauthorized (401)${"x".repeat(4096)}` },
    { failureReason: "authentication_required" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 418 } } },
    { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null, detail: "private" } } },
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
