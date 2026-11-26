import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import skill from "../../../../../../skills/matrix/mac-verification/SKILL.md?raw";

export const MAC_VERIFICATION_DEFAULT_TASK = "Verify the current worktree changes on my Mac.";
const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();

/** Load only the shipped Skill. A model prompt cannot select a native path. */
export function macVerificationWorkflowParts(parts: readonly CanonicalChatMessagePart[]): CanonicalChatMessagePart[] {
  return [...parts, { type: "text", text: `${body}\n\nThis turn has a Matrix-native post-completion Mac verification continuation. Use the admitted execution root; do not select another checkout.` }];
}
