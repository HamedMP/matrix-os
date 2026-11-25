import { z } from "zod/v4";
import { CanonicalChatIdSchema, MatrixComputerHandleSchema, type NotificationPreferences } from "@matrix-os/contracts";
import type { AttentionRequest } from "./request-source.js";
import type { NotificationEvent } from "./repository.js";

export const AttentionPushSchema = z.object({
  id: z.uuid(), ownerId: z.string().min(1).max(128), kind: z.enum(["approval", "question"]),
  title: z.string().max(80), body: z.string().max(180),
  target: z.object({ type: z.literal("chat"), chatId: CanonicalChatIdSchema }).strict(),
  sound: z.boolean(), timeSensitive: z.boolean(), expiresAt: z.iso.datetime(),
}).strict();
export type AttentionPush = z.infer<typeof AttentionPushSchema>;
export const AttentionPhoneDataSchema = z.object({ v: z.literal(1), notificationId: z.uuid(),
  handle: MatrixComputerHandleSchema, target: AttentionPushSchema.shape.target }).strict();
export interface NotificationTransport { send(notification: AttentionPush): Promise<void> }

/** Only an allowlisted request title may leave the VPS. Never tool args, descriptions, or bot previews. */
function safeTitle(value: string | undefined): string | undefined {
  if (!value || /(?:postgres|openai|anthropic|twilio|bearer\s|[\\/]|token\s*[=:]|password\s*[=:]|sk-|ghp_)/i.test(value)) return undefined;
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/[*_`#<>]/g, "").trim().slice(0, 180) || undefined;
}
export function attentionPush(event: NotificationEvent, request: AttentionRequest, preferences: NotificationPreferences): AttentionPush {
  return AttentionPushSchema.parse({ id: event.id, ownerId: event.owner_id, kind: event.kind, title: "Matrix OS",
    body: (preferences.content.showPreview && safeTitle(request.preview))
      || (event.kind === "approval" ? "Your agent needs approval" : "Your agent has a question"),
    target: { type: "chat", chatId: event.chat_id }, sound: preferences.content.sound,
    timeSensitive: preferences.content.timeSensitive, expiresAt: request.expiresAt.toISOString(),
  });
}
