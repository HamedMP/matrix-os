import { generatedChatTitle } from "@matrix-os/ui";
import { LEGACY_TERMINAL_CONTROL_COMMAND, TERMINAL_CONTROL_COMMAND } from "@matrix-os/contracts/herdr-terminals";
import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import type { SharedChatComposerSubmission } from "./composer-reference-tokens";

export function canonicalChatInputParts(
  submission: SharedChatComposerSubmission,
): CanonicalChatMessagePart[] {
  return [
    ...(submission.text ? [{ type: "text" as const, text: submission.text }] : []),
    // The picker supplies this command only on a fresh owner choice, outside durable draft tokens.
    ...submission.invocations.filter(invocation => invocation.descriptorId !== TERMINAL_CONTROL_COMMAND.descriptorId
      && invocation.descriptorId !== LEGACY_TERMINAL_CONTROL_COMMAND.descriptorId).map((invocation) => ({
      type: "invocation_reference" as const,
      invocation,
    })),
    ...submission.resources.map((resource) => ({
      type: "resource_reference" as const,
      resource,
    })),
  ];
}

export function canonicalChatTitle(submission: SharedChatComposerSubmission): string {
  return generatedChatTitle(submission.text,
    submission.invocations[0]?.invocation || submission.resources[0]?.label);
}

export function canonicalChatRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
