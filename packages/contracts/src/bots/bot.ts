import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
import { canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
import { BotIdSchema, BotRevisionSchema } from "#bots/ids";

export const BotRecipeRefSchema = z.object({
  recipeId: canonicalReferenceId(128),
  version: canonicalReferenceId(64),
}).strict();

/** The server chooses bot, chat, workspace, avatar, and runtime; the client supplies intent only. */
export const InstantiateBotRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  recipe: BotRecipeRefSchema,
  name: canonicalSafeLabel(80, 320).optional(),
}).strict();

export const BotSummarySchema = z.object({
  id: BotIdSchema,
  name: canonicalSafeLabel(80, 320),
  avatarSeed: z.string().regex(/^[a-f0-9]{16,64}$/),
  revision: BotRevisionSchema,
  status: z.enum(["active", "recovering"]),
}).strict();

export const InstantiateBotResponseSchema = z.object({
  agent: BotSummarySchema,
  chatId: CanonicalChatIdSchema,
  operation: z.enum(["created", "replayed"]),
}).strict();

export type BotRecipeRef = z.infer<typeof BotRecipeRefSchema>;
export type InstantiateBotRequest = z.infer<typeof InstantiateBotRequestSchema>;
export type BotSummary = z.infer<typeof BotSummarySchema>;
export type InstantiateBotResponse = z.infer<typeof InstantiateBotResponseSchema>;
