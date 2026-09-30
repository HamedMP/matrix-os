import { CanonicalChatToolOutputTextSchema, type CanonicalChatContent, type CanonicalOwnerScope } from "@matrix-os/contracts";
import { openToolOutput } from "../coding-agents/protected-tool-output.mjs";
import { redactAssistantParts, redactAssistantPaths } from "./safe-activity-projection.js";

export type OwnerToolOutputProjection = <T extends Pick<CanonicalChatContent, "record" | "activities" | "messages" | "messageDelta">>(owner: CanonicalOwnerScope, content: T) => T;

/** Invoke only after repository/transport owner authorization. Only personal,
 * unshared reads may decrypt tool output. Always copy persisted content. */
export function createOwnerToolOutputProjection(key: Buffer | undefined, runtimeOwnerIds: readonly string[]): OwnerToolOutputProjection {
  return (owner, content) => {
    const scope = content.record.chat.ownerScope;
    const shared = content.record.chat.collaboration?.mode === "shared";
    const allowed = owner.type === "personal" && scope.type === "personal"
      && owner.ownerId === scope.ownerId && runtimeOwnerIds.includes(owner.ownerId)
      && !shared;
    return {
      ...content,
      ...(shared ? {
        record: { ...content.record, chat: { ...content.record.chat,
          ...(content.record.chat.lastMessagePreview ? {
            lastMessagePreview: redactAssistantPaths(content.record.chat.lastMessagePreview),
          } : {}),
        } },
        ...(content.messages ? { messages: content.messages.map((message) => message.role === "assistant"
          ? { ...message, parts: redactAssistantParts(message.parts) }
          : message) } : {}),
        // Historical private deltas can split a path across events. A shared
        // response uses the complete projected message instead.
        messageDelta: undefined,
      } : {}),
      ...(content.activities ? { activities: content.activities.flatMap((activity) => {
        if (shared && activity.type === "assistant.delta") return [];
        if (shared && activity.type === "agent.activity") {
          return { ...activity,
            ...(activity.preview ? { preview: redactAssistantPaths(activity.preview) } : {}),
            ...(activity.detail ? { detail: redactAssistantPaths(activity.detail) } : {}),
            ...(activity.summary ? { summary: redactAssistantPaths(activity.summary) } : {}),
          };
        }
        if (activity.type !== "tool.output") return activity;
        const { protectedOutput, ...coarse } = activity;
        if (shared) return { ...coarse, text: redactAssistantPaths(coarse.text) };
        if (!protectedOutput) return activity;
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
