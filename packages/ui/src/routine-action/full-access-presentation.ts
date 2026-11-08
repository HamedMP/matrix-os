import type { CanonicalChatSummary } from "@matrix-os/contracts";

/** Presentation eligibility only; the server independently authorizes every scope and new turn. */
export function routineFullAccessChatPresentationEligible({ chat, ordinary, fresh }: {
  chat?: Pick<CanonicalChatSummary, "ownerScope" | "lifecycle" | "collaboration">; ordinary: boolean; fresh: boolean;
}): boolean {
  return fresh && ordinary && chat?.ownerScope.type === "personal" && chat.lifecycle === "active" && !chat.collaboration;
}
