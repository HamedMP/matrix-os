import { projectPlaintextToolPreview } from "./plaintext-tool-preview.js";
import { CanonicalChatCommandPreviewSchema, CanonicalChatToolOutputTextSchema, type CanonicalChatRunActivity, type CanonicalChatContent, type CanonicalOwnerScope } from "@matrix-os/contracts";
import { openToolPreview, openToolOutput } from "../coding-agents/protected-tool-output.mjs";
import { redactAssistantCredentialParts, redactAssistantCredentials, redactAssistantParts, redactSharedAssistantText } from "./safe-activity-projection.js";

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
      ...(content.record.chat.lastMessagePreview ? { record: { ...content.record, chat: {
        ...content.record.chat,
        lastMessagePreview: shared
          ? redactSharedAssistantText(content.record.chat.lastMessagePreview)
          : redactAssistantCredentials(content.record.chat.lastMessagePreview),
      } } } : {}),
      ...(shared ? {
        // Historical private deltas can split a path across events. A shared
        // response uses the complete projected message instead.
        messageDelta: undefined,
      } : {}),
      ...(content.messages ? { messages: content.messages.map((message) => message.role === "assistant"
        ? { ...message, parts: shared
          ? redactAssistantParts(message.parts) : redactAssistantCredentialParts(message.parts) }
        : message) } : {}),
      ...(content.activities ? { activities: content.activities.flatMap((activity) => {
        if (shared && activity.type === "assistant.delta") return [];
        if (activity.type === "agent.activity") {
          const { protectedPreview, ...storedCoarse } = activity;
          const coarse = projectPlaintextToolPreview(storedCoarse);
          const visible = !allowed ? {
            ...coarse,
            ...(coarse.preview ? { preview: redactSharedAssistantText(coarse.preview) } : {}),
            ...(coarse.detail ? { detail: redactSharedAssistantText(coarse.detail) } : {}),
            ...(coarse.summary ? { summary: redactSharedAssistantText(coarse.summary) } : {}),
          } : coarse;
          if (!protectedPreview || !key || !allowed || activity.kind !== "command"
            || activity.chatId !== content.record.chat.id) return visible;
          try {
            const preview = CanonicalChatCommandPreviewSchema.safeParse(openToolPreview(key, activity.activityId, protectedPreview));
            return preview.success ? { ...visible, preview: preview.data, previewKind: "command" as const } : visible;
          } catch (error: unknown) {
            console.warn("[chat/tool-output] Could not open protected command:", error instanceof Error ? error.name : "UnknownError");
            return visible;
          }
        }
        if (activity.type !== "tool.output") return activity;
        const { protectedOutput, ...coarse } = activity;
        if (shared) return { ...coarse, text: redactSharedAssistantText(coarse.text) };
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

/** General/export copies never carry the command reveal sidecar. */
export function stripProtectedCommandPreviews(activities: CanonicalChatRunActivity[]): CanonicalChatRunActivity[] {
  return activities.map(activity => {
    if (activity.type !== "agent.activity") return activity;
    const { protectedPreview: _protectedPreview, ...coarse } = activity;
    return projectPlaintextToolPreview(coarse);
  });
}
