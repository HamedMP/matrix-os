import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import type { SharedChatComposerSubmission } from "./composer-reference-tokens";

export function canonicalChatInputParts(
  submission: SharedChatComposerSubmission,
): CanonicalChatMessagePart[] {
  return [
    ...(submission.text ? [{ type: "text" as const, text: submission.text }] : []),
    ...submission.invocations.map((invocation) => ({
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
  return submission.text.replace(/\s+/g, " ").slice(0, 80)
    || submission.invocations[0]?.invocation
    || submission.resources[0]?.label
    || "New chat";
}

export function canonicalChatRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
