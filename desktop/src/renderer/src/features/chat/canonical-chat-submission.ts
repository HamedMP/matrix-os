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

function structuredPromptTitle(prompt: string): string | null {
  const markerMatches = prompt.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]*)+\b/g);
  for (const match of markerMatches) {
    const marker = match[0];
    const markerWords = marker.split(/[_-]+/).filter(Boolean);
    const looksLikeMarker = /\d/.test(marker)
      || markerWords.some((word) => word.length > 1 && word === word.toUpperCase());
    if (!looksLikeMarker) continue;

    const prefix = prompt.slice(0, match.index);
    const objectNouns = Array.from(prefix.matchAll(/\b(lines?|steps?|items?|bullets?|rows?|entries|examples?|commands?|tests?|messages?|responses?|results?|files?)\b/gi));
    const objectNoun = objectNouns.at(-1)?.[0]?.toLocaleLowerCase();
    if (!objectNoun) continue;

    const topic = [...markerWords, objectNoun].join(" ");
    return `${topic[0]?.toLocaleUpperCase()}${topic.slice(1)}`;
  }
  return null;
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
  const structuredTitle = visiblePrompt ? structuredPromptTitle(visiblePrompt) : null;
  const maxLength = 56;
  const conciseSource = structuredTitle ?? visiblePrompt;
  const concise = conciseSource && conciseSource.length > maxLength
    ? `${conciseSource.slice(0, maxLength - 1).replace(/\s+\S*$/, "").trimEnd()}…`
    : conciseSource;
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
