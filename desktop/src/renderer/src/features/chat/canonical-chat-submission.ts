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
  const visiblePrompt = submission.text
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:\/[a-z][a-z0-9_-]*\s+)+/i, "")
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|help me\s+(?:to\s+)?|i (?:want|need) you to\s+|let['’]?s\s+)/i, "")
    .replace(/^(?:请(?:帮我)?|帮我|麻烦(?:你)?|能不能|可以)\s*/u, "")
    .split(/[!?。！？]|\.(?:\s|$)/u, 1)[0]
    ?.trim();
  const maxLength = 56;
  const concise = visiblePrompt && visiblePrompt.length > maxLength
    ? `${visiblePrompt.slice(0, maxLength - 1).replace(/\s+\S*$/, "").trimEnd()}…`
    : visiblePrompt;
  const titled = concise && /^[a-z]/.test(concise)
    ? `${concise[0]?.toLocaleUpperCase()}${concise.slice(1)}`
    : concise;
  return titled
    || submission.invocations[0]?.invocation
    || submission.resources[0]?.label
    || "New chat";
}

export function canonicalChatRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
