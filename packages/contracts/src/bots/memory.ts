import { z } from "zod/v4";
import { CanonicalChatMessageIdSchema } from "#canonical-chat";
import { canonicalBoundedText } from "#canonical-chat-primitives";
import { IsoTimestampSchema } from "#contract-primitives";
import { BotMemoryItemIdSchema, BotRevisionSchema } from "#bots/ids";

export const BotMemoryKindSchema = z.enum(["preference", "fact", "episode"]);
/** `bot` spans the bot's private conversations; `chat:` and `group:` bind one conversation. */
export const BotMemoryScopeSchema = z.union([
  z.literal("bot"),
  z.string().regex(/^(chat|group):chat_[A-Za-z0-9_-]{1,128}$/),
]);
export const BotMemoryContentSchema = canonicalBoundedText(4_096, 4_096);
export const BotHttpsUrlSchema = z.url({ protocol: /^https$/ }).max(2_048);

export const BotMemorySourceSchema = z.object({
  messageId: CanonicalChatMessageIdSchema.optional(),
  url: BotHttpsUrlSchema.optional(),
  at: IsoTimestampSchema,
}).strict();

export const BotMemoryItemSchema = z.object({
  itemId: BotMemoryItemIdSchema,
  kind: BotMemoryKindSchema,
  scope: BotMemoryScopeSchema,
  content: BotMemoryContentSchema,
  source: BotMemorySourceSchema,
  confirmed: z.boolean(),
  revision: BotRevisionSchema,
}).strict();

export const BotMemoryMutationRequestSchema = z.object({ baseRevision: BotRevisionSchema }).strict();
export const BotMemoryMutationResponseSchema = z.object({
  itemId: BotMemoryItemIdSchema,
  revision: BotRevisionSchema,
}).strict();

export type BotMemoryKind = z.infer<typeof BotMemoryKindSchema>;
export type BotMemoryScope = z.infer<typeof BotMemoryScopeSchema>;
export type BotMemoryItem = z.infer<typeof BotMemoryItemSchema>;
