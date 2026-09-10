import { CanonicalChatSafeErrorSchema, type CanonicalChatSafeError, type CanonicalCreateChatTurnRequest, type CanonicalChatMessage } from "@matrix-os/contracts";
import { ChatAgentContextError } from "./agent-context.js";
import { ChatNotFoundError, ChatBusyError, ChatProviderInstanceLockedError, ChatRunNotAcknowledgeableError, ChatRunNotActiveError, ChatConflictError } from "./errors.js";

export class CanonicalChatOrchestrationError extends Error {
  constructor(readonly safeError: CanonicalChatSafeError, readonly status: 400 | 404 | 409 | 503) {
    super(safeError.safeMessage);
    this.name = "CanonicalChatOrchestrationError";
  }
}

export function safeError(
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

export function promptFor(parts: CanonicalCreateChatTurnRequest["parts"]): string {
  const lines = parts.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "invocation_reference") {
      return [`${part.invocation.invocation}${part.invocation.arguments ? ` ${part.invocation.arguments}` : ""}`];
    }
    if (part.type === "resource_reference") return [`@${part.resource.label}`];
    if (part.type === "attachment_reference" && !part.ownerReference) return [`@${part.label}`];
    return [];
  });
  const attachmentReferences = parts.flatMap((part) => (
    part.type === "attachment_reference" && part.ownerReference
      ? [`- ${JSON.stringify(part.label)}: ${shellQuotedOwnerReference(part.ownerReference)}`]
      : []
  ));
  if (attachmentReferences.length > 0) {
    lines.push(
      "",
      "Attached files (available on this Matrix computer):",
      ...attachmentReferences,
    );
  }
  const prompt = lines.join("\n").trim();
  if (!prompt) throw new CanonicalChatOrchestrationError(
    safeError("capability_mismatch", "The message does not contain supported input."),
    400,
  );
  return prompt;
}

export function retryPromptFor(messages: CanonicalChatMessage[]): string {
  return messages.map((message) => promptFor(message.parts)).join("\n\n");
}

function shellQuotedOwnerReference(ownerReference: string): string {
  return `"$MATRIX_HOME"/'${ownerReference.replaceAll("'", "'\\''")}'`;
}

export function requirementsFor(input: CanonicalCreateChatTurnRequest) {
  return {
    attachments: input.parts.flatMap((part) =>
      part.type === "attachment_reference" ? [part.kind] : []
    ),
    resources: input.parts.flatMap((part) =>
      part.type === "resource_reference" ? [part.resource.kind] : []
    ),
    interactionMode: input.interactionMode,
    permissionMode: input.permissionMode,
    worktree: input.executionRoot?.kind === "worktree",
  };
}

export function mapRepositoryError(error: unknown): never {
  if (error instanceof ChatAgentContextError) {
    throw new CanonicalChatOrchestrationError(error.code === "context_unavailable"
      ? safeError("resource_unavailable", "The selected Agent or Chat is unavailable.")
      : safeError("capability_mismatch", error.code === "agent_permission_required"
        ? "This Agent requires Full access. Select it before sending."
        : "Agents and Chat references are disabled."), 400);
  }
  if (error instanceof ChatNotFoundError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_not_found", "Chat not found."), 404);
  }
  if (error instanceof ChatBusyError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_busy", "This Chat already has an active Run."), 409);
  }
  if (error instanceof ChatProviderInstanceLockedError) {
    throw new CanonicalChatOrchestrationError(safeError(
      "provider_instance_locked",
      "This Chat is already bound to another Provider instance.",
      false,
      ["fork_chat", "start_new_chat"],
    ), 409);
  }
  if (error instanceof ChatRunNotAcknowledgeableError) {
    throw new CanonicalChatOrchestrationError(safeError(
      "run_unavailable",
      "Only a successful completed Run can be acknowledged.",
    ), 409);
  }
  if (error instanceof ChatRunNotActiveError) {
    throw new CanonicalChatOrchestrationError(
      safeError("run_unavailable", "The Run is no longer active."),
      409,
    );
  }
  if (error instanceof ChatConflictError) {
    throw new CanonicalChatOrchestrationError(safeError("chat_conflict", "Chat changed. Refresh and try again.", true, ["retry"]), 409);
  }
  throw error;
}

