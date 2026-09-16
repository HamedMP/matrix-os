import type { CanonicalCreateChatTurnRequest, CanonicalChatMessage } from "@matrix-os/contracts";
import {
  CanonicalChatOrchestrationError,
  canonicalChatSafeError as safeError,
} from "./orchestration-errors.js";

export {
  CanonicalChatOrchestrationError,
  canonicalChatSafeError as safeError,
  mapRepositoryError,
} from "./orchestration-errors.js";

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
