import type { CanonicalChatSafeError } from "@matrix-os/contracts";
import { ZodError } from "zod/v4";
import { AppError, categoryMessage } from "../../../../shared/app-error";
import { chatSendFailureMessage } from "./chat-send-error";

const CANONICAL_CHAT_SUBMIT_REASONS: Record<CanonicalChatSafeError["code"], string> = {
  chat_not_found: "This Chat no longer exists. Start a new Chat.",
  chat_busy: "This Chat already has an active response. Wait for it to finish or stop it.",
  chat_conflict: "This Chat changed before the message was sent. Refresh and try again.",
  chat_unavailable: "This Chat is temporarily unavailable. Try again.",
  project_required: "Choose a Project before sending this message.",
  project_unavailable: "The selected Project is unavailable. Choose another Project.",
  provider_unavailable: "The selected provider is unavailable. Choose another provider or finish setup.",
  provider_instance_locked: "This Chat is locked to another provider. Use that provider or start a new Chat.",
  model_unavailable: "The selected model is unavailable. Choose another model.",
  capability_mismatch: "The selected provider does not support one of the requested options or attachments.",
  run_not_found: "The previous Run no longer exists. Refresh and try again.",
  run_not_resumable: "The previous Run cannot be resumed. Start a new message.",
  run_unavailable: "The agent Run is temporarily unavailable. Try again.",
  history_window_required: "This Chat needs more recent history before it can continue. Refresh and try again.",
  migration_in_progress: "This Chat is being upgraded. Wait a moment and try again.",
  run_failed: "The agent Run failed before it could start. Try again.",
  resource_unavailable: "One of the referenced files or resources is unavailable.",
  authorization_failed: "You do not have permission to send this message.",
  service_unavailable: "Chat service is temporarily unavailable. Try again.",
};

export function canonicalChatSubmitFailureReason(error: unknown): string {
  if (error instanceof AppError) {
    const reason = error.detail
      ? CANONICAL_CHAT_SUBMIT_REASONS[error.detail as CanonicalChatSafeError["code"]]
      : undefined;
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
