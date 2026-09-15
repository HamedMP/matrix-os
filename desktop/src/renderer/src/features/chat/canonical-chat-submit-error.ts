import { canonicalChatSafeFailureReason } from "@matrix-os/ui";
import { ZodError } from "zod/v4";
import { AppError, categoryMessage } from "../../../../shared/app-error";
import { chatSendFailureMessage } from "./chat-send-error";

export function canonicalChatSubmitFailureReason(error: unknown): string {
  if (error instanceof AppError) {
    const reason = canonicalChatSafeFailureReason(error.detail);
    return reason ?? categoryMessage(error.category);
  }
  if (error instanceof ZodError) {
    return "The message or its attachments do not match the supported format.";
  }
  return categoryMessage("server");
}

export function canonicalChatSubmitFailureMessage(error: unknown): string {
  return chatSendFailureMessage(canonicalChatSubmitFailureReason(error));
}
