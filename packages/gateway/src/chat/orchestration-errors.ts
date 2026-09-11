import {
  CanonicalChatSafeErrorSchema,
  type CanonicalChatSafeError,
} from "@matrix-os/contracts";
import {
  ChatBusyError,
  ChatConflictError,
  ChatNotFoundError,
  ChatProviderInstanceLockedError,
  ChatRunNotAcknowledgeableError,
  ChatRunNotActiveError,
} from "./errors.js";

export class CanonicalChatOrchestrationError extends Error {
  constructor(readonly safeError: CanonicalChatSafeError, readonly status: 400 | 404 | 409 | 503) {
    super(safeError.safeMessage);
    this.name = "CanonicalChatOrchestrationError";
  }
}

export function canonicalChatSafeError(
  code: CanonicalChatSafeError["code"],
  safeMessage: string,
  retryable = false,
  recoveryActions?: CanonicalChatSafeError["recoveryActions"],
): CanonicalChatSafeError {
  return CanonicalChatSafeErrorSchema.parse({
    code,
    safeMessage,
    retryable,
    ...(recoveryActions ? { recoveryActions } : {}),
  });
}

export function mapRepositoryError(error: unknown): never {
  if (error instanceof ChatNotFoundError) {
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError("chat_not_found", "Chat not found."), 404);
  }
  if (error instanceof ChatBusyError) {
    throw new CanonicalChatOrchestrationError(
      canonicalChatSafeError("chat_busy", "This Chat already has an active Run."),
      409,
    );
  }
  if (error instanceof ChatProviderInstanceLockedError) {
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError(
      "provider_instance_locked",
      "This Chat is already bound to another Provider instance.",
      false,
      ["fork_chat", "start_new_chat"],
    ), 409);
  }
  if (error instanceof ChatRunNotAcknowledgeableError) {
    throw new CanonicalChatOrchestrationError(canonicalChatSafeError(
      "run_unavailable",
      "Only a successful completed Run can be acknowledged.",
    ), 409);
  }
  if (error instanceof ChatRunNotActiveError) {
    throw new CanonicalChatOrchestrationError(
      canonicalChatSafeError("run_unavailable", "The Run is no longer active."),
      409,
    );
  }
  if (error instanceof ChatConflictError) {
    throw new CanonicalChatOrchestrationError(
      canonicalChatSafeError("chat_conflict", "Chat changed. Refresh and try again.", true, ["retry"]),
      409,
    );
  }
  throw error;
}
