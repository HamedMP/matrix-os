import type { CanonicalChatResourceReference, CanonicalChatRun, CanonicalChatMessagePart } from "@matrix-os/contracts";

export function isChatMention(resource: CanonicalChatResourceReference): boolean {
  return resource.kind === "agent" || resource.kind === "chat";
}
export function hasChatMentionParts(parts: CanonicalChatMessagePart[]): boolean {
  return parts.some((part) => part.type === "resource_reference" && isChatMention(part.resource));
}
export function canAddChatMention(resources: CanonicalChatResourceReference[], next: CanonicalChatResourceReference): boolean {
  if (resources.some((resource) => resource.kind === next.kind && resource.id === next.id)) return false;
  if (next.kind === "agent") return !resources.some((resource) => resource.kind === "agent");
  if (next.kind === "chat") return resources.filter((resource) => resource.kind === "chat").length < 3;
  return true;
}
export function orderChatResources(resources: CanonicalChatResourceReference[]): CanonicalChatResourceReference[] {
  const rank = (kind: string) => kind === "agent" ? 0 : kind === "chat" ? 1 : 2;
  return [...resources].sort((left, right) => rank(left.kind) - rank(right.kind));
}
/** Attribution comes only from the persisted Run, never a user-supplied token label. */
export function chatAgentAttribution(run?: CanonicalChatRun): string | undefined {
  return run?.context?.agent ? `${run.context.agent.name} · Hermes` : undefined;
}
