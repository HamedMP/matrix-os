import { CanonicalChatToolOutputTextSchema, type CanonicalChatContent, type CanonicalOwnerScope } from "@matrix-os/contracts";
import { openToolOutput } from "../coding-agents/protected-tool-output.mjs";

export type OwnerToolOutputProjection = <T extends Pick<CanonicalChatContent, "record" | "activities">>(owner: CanonicalOwnerScope, content: T) => T;

/** Invoke only after repository/transport owner authorization. Never use on a
 * persistence, telemetry, collaboration, share or export path. Always copy. */
export function createOwnerToolOutputProjection(key: Buffer | undefined, runtimeOwnerIds: readonly string[]): OwnerToolOutputProjection {
  return (owner, content) => {
    const scope = content.record.chat.ownerScope;
    const allowed = owner.type === "personal" && scope.type === "personal"
      && owner.ownerId === scope.ownerId && runtimeOwnerIds.includes(owner.ownerId)
      && content.record.chat.collaboration?.mode !== "shared";
    return { ...content, ...(content.activities ? { activities: content.activities.map((activity) => {
      if (activity.type !== "tool.output" || !activity.protectedOutput) return activity;
      const { protectedOutput, ...coarse } = activity;
      if (!key || !allowed || activity.chatId !== content.record.chat.id) return coarse;
      try {
        const result = CanonicalChatToolOutputTextSchema.safeParse(openToolOutput(key, activity.toolCallId, protectedOutput));
        return result.success ? { ...coarse, text: result.data } : coarse;
      } catch (error: unknown) {
        // Corrupt/old ciphertext must not break Chat replay or disclose key data.
        console.warn("[chat/tool-output] Could not open protected result:", error instanceof Error ? error.name : "UnknownError");
        return coarse;
      }
    }) } : {}) };
  };
}
