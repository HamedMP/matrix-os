import { describe, expect, it } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import {
  canonicalChatSubmitFailureMessage,
  canonicalChatSubmitFailureReason,
} from "@desktop/renderer/src/features/chat/canonical-chat-submit-error";

describe("canonical Chat submit failures", () => {
  it("translates allowlisted canonical error codes", () => {
    expect(canonicalChatSubmitFailureMessage(
      new AppError("server", { detail: "model_unavailable" }),
    )).toBe(
      "The message could not be sent. Reason: The selected model is unavailable. Choose another model.",
    );
  });

  it("does not expose unknown server details", () => {
    expect(canonicalChatSubmitFailureReason(
      new AppError("server", { detail: "provider secret detail" }),
    )).toBe("Something went wrong. Please try again.");
  });
  it("uses the same neutral connection recovery and rejects prototype names", () => {
    expect(canonicalChatSubmitFailureReason(new AppError("server", { detail: "provider_unavailable" })))
      .toBe("This connection is currently unavailable. Open Agents & providers to check it.");
    expect(canonicalChatSubmitFailureReason(new AppError("server", { detail: "toString" })))
      .toBe("Something went wrong. Please try again.");
  });
});
