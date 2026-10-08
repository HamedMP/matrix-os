import type { CanonicalChatMessagePart, CanonicalChatResourceReference } from "@matrix-os/contracts";
/** Echo only the loaded exact Bot revision to scope request consent. Server resolves its definition. */
export function botSubmissionParts(parts: CanonicalChatMessagePart[], resources: CanonicalChatResourceReference[]): CanonicalChatMessagePart[] {
  return resources.length ? [...parts, ...resources.map(resource => ({ type: "resource_reference" as const, resource }))] : parts;
}
