import { describe, expect, it } from "vitest";
import { BotEntryError } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { CanonicalChatOrchestrationError } from "../../../packages/gateway/src/chat/orchestration-errors.js";
import { retainedThreadEntryFailure } from "./deployed-v9-entry-support.js";

describe("retained thread entry failure diagnostics (no database)", () => {
  it("identifies the explicit Bot entry refusal", () => {
    expect(retainedThreadEntryFailure(new BotEntryError("unavailable"))).toEqual({
      accepted: false, errorType: "BotEntryError", code: "unavailable",
    });
  });
  it("retains the canonical safe error and status instead of hiding a Chat conflict", () => {
    const error = new CanonicalChatOrchestrationError({ code: "chat_conflict", safeMessage: "Synthetic conflict", retryable: true }, 409);
    expect(retainedThreadEntryFailure(error)).toEqual({ accepted: false,
      errorType: "CanonicalChatOrchestrationError", code: "chat_conflict", status: 409, retryable: true,
    });
  });
  it("preserves a non-retryable unsupported thread response with no retry action", () => {
    const error = new CanonicalChatOrchestrationError({ code: "resource_unavailable", safeMessage: "Unavailable", retryable: false, recoveryActions: [] }, 503);
    expect(retainedThreadEntryFailure(error)).toEqual({ accepted: false, errorType: "CanonicalChatOrchestrationError", code: "resource_unavailable", status: 503, retryable: false, recoveryActions: [] });
  });
  it("rethrows the original unknown failure including its stack and details", () => {
    const error = Object.assign(new Error("Synthetic unknown failure"), { constraint: "synthetic_constraint" });
    let caught: unknown;
    try { retainedThreadEntryFailure(error); } catch (failure: unknown) { caught = failure; }
    expect(caught).toBe(error);
  });
});
