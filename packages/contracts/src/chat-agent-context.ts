import { z } from "zod/v4";
import { canonicalBoundedText, canonicalSafeLabel, canonicalEncodedByteLength } from "#canonical-chat-primitives";

export const ChatAgentIdSchema = z.string().regex(/^bot_[a-z0-9]{8,64}$/);
export const ChatContextSnapshotSchema = z.object({
  chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,120}$/),
  // Match persisted Chat titles, including existing 200-character titles.
  title: canonicalBoundedText(200, 1024),
  throughSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  text: z.string().max(16_000),
  truncated: z.boolean(),
}).strict();

/** Written only by the gateway after owner-scoped resolution, never accepted from a client. */
export const ChatRunContextSchema = z.object({
  version: z.literal(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.object({
    id: ChatAgentIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    name: canonicalSafeLabel(80, 320),
    instructions: canonicalBoundedText(8_000, 24 * 1024),
  }).strict().optional(),
  chats: z.array(ChatContextSnapshotSchema).max(3),
  history: ChatContextSnapshotSchema.optional(),
}).strict().refine((value) => canonicalEncodedByteLength(value) <= 64 * 1024, {
  message: "Resolved Chat context exceeds its byte limit",
});

export type ChatContextSnapshot = z.infer<typeof ChatContextSnapshotSchema>;
export type ChatRunContext = z.infer<typeof ChatRunContextSchema>;
