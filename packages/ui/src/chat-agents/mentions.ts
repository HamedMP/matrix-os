import type { CanonicalChatResourceReference, CanonicalChatRun, CanonicalChatMessagePart } from "@matrix-os/contracts";

/** Identity is independent of mutable labels and includes the selected drive subresource. */
export function chatResourceKey(resource: CanonicalChatResourceReference): string {
  const ref = resource.drive;
  return resource.kind === "organization_drive" && ref
    ? `${resource.kind}:${ref.organizationId}:${ref.scopeId}:${ref.kind}:${ref.kind === "folder" ? ref.path : ref.kind === "file" ? `${ref.fileId}:${ref.version}` : ""}`
    : `${resource.kind}:${resource.id}`;
}
export function isChatMention(resource: CanonicalChatResourceReference): boolean {
  return resource.kind === "agent" || resource.kind === "chat" || resource.kind === "organization_drive" || resource.kind === "memory_source";
}
export function hasChatMentionParts(parts: CanonicalChatMessagePart[]): boolean {
  return parts.some((part) => part.type === "resource_reference" && isChatMention(part.resource));
}
export function canAddChatMention(resources: CanonicalChatResourceReference[], next: CanonicalChatResourceReference): boolean {
  if (resources.some((resource) => chatResourceKey(resource) === chatResourceKey(next))) return false;
  if (next.kind === "agent") return !resources.some((resource) => resource.kind === "agent");
  if (next.kind === "chat") return resources.filter((resource) => resource.kind === "chat").length < 3;
  if (next.kind === "organization_drive") return resources.filter(resource => resource.kind === "organization_drive").length < 3;
  if (next.kind === "memory_source") return resources.filter(resource => resource.kind === "memory_source").length < 8;
  return true;
}
export function orderChatResources(resources: CanonicalChatResourceReference[]): CanonicalChatResourceReference[] {
  const rank = (kind: string) => kind === "agent" ? 0 : kind === "chat" ? 1 : 2;
  return [...resources].sort((left, right) => rank(left.kind) - rank(right.kind));
}
/** Attribution comes only from the persisted Run, never a user-supplied token label. */
export function chatAgentAttribution(run?: CanonicalChatRun): string | undefined {
  if (!run?.context?.agent) return undefined;
  const harness = run.driverKind === "codex" ? "Codex" : run.driverKind === "hermes" ? "Hermes" : "Agent";
  return `${run.context.agent.name} · ${harness}`;
}
