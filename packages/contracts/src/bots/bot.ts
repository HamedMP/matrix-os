import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema, CanonicalChatModelSelectionSchema } from "#canonical-chat";
import { CanonicalChatApiCursorSchema } from "#canonical-chat-api";
import { canonicalBoundedText, canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
import { BotIdSchema, BotRevisionSchema } from "#bots/ids";

export const BotRecipeRefSchema = z.object({
  recipeId: canonicalReferenceId(128),
  version: canonicalReferenceId(64),
}).strict();

/** Public launch metadata; the server keeps instructions and capability policy private. */
export const BotRecipeSummarySchema = BotRecipeRefSchema.extend({
  name: canonicalSafeLabel(80, 320),
  description: canonicalBoundedText(400, 1_600),
  output: canonicalBoundedText(1_000, 4_000),
}).strict();
export const BotRecipeListResponseSchema = z.object({
  recipes: z.array(BotRecipeSummarySchema).max(128),
}).strict();
export const BotChatBindingResponseSchema = z.object({ chatId: CanonicalChatIdSchema.nullable() }).strict();
export const BotDirectChatResponseSchema = z.object({ agentId: BotIdSchema.nullable() }).strict();

/** The server chooses bot, chat, workspace, avatar, and runtime; the client supplies intent only. */
export const InstantiateBotRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  recipe: BotRecipeRefSchema,
  name: canonicalSafeLabel(80, 320).optional(),
  selection: CanonicalChatModelSelectionSchema.optional(),
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

/** A thread is one more Chat of a Bot, fixed to one project when it is created (spec 567). */
export const BotThreadProjectIdSchema = z.string().regex(/^proj_[A-Za-z0-9_-]{1,128}$/);

/** POST /api/chat-agents/:agentId/threads. The reply is the Chat record `POST /api/chats` returns. */
export const CreateBotThreadRequestSchema = z.object({
  clientRequestId: CanonicalChatRequestIdSchema,
  projectId: BotThreadProjectIdSchema,
  title: canonicalSafeLabel(120, 480).optional(),
}).strict();

/** GET /api/chat-agents/:agentId/threads. The reply is the list `GET /api/chats` returns, newest activity first. */
export const BotThreadListQuerySchema = z.object({
  projectId: BotThreadProjectIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

export type BotRecipeRef = z.infer<typeof BotRecipeRefSchema>;
export type CreateBotThreadRequest = z.infer<typeof CreateBotThreadRequestSchema>;
export type BotThreadListQuery = z.infer<typeof BotThreadListQuerySchema>;
export type BotRecipeSummary = z.infer<typeof BotRecipeSummarySchema>;
export type InstantiateBotRequest = z.infer<typeof InstantiateBotRequestSchema>;
export type BotSummary = z.infer<typeof BotSummarySchema>;
export type InstantiateBotResponse = z.infer<typeof InstantiateBotResponseSchema>;
