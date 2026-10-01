import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
/** Context identity is immutable for queued work; editing text cannot substitute a new capability scope. */
export function admittedContextReferenceParts<Part extends CanonicalChatMessagePart>(parts: readonly Part[]): Part[] {
    return parts.filter(part => part.type === "resource_reference" && ["agent", "chat", "organization_drive"].includes(part.resource.kind));
}
