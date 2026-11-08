import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatMessageIdSchema } from "#canonical-chat";
import { BotInteractionSchema, botInteractionPayloadByteLimit } from "#bots/interactions";
import { IsoTimestampSchema } from "#contract-primitives";
import { RoutineChatReceiptPartSchema } from "#routine-chat-receipt";
export { RoutineChatReceiptPartSchema, ROUTINE_DIRECT_CHAT_ID_PATTERN, ROUTINE_DIRECT_BOT_ID_PATTERN,
  isRoutineDirectChatId, isRoutineDirectBotId, type RoutineChatReceiptPart } from "#routine-chat-receipt";

const ROUTINE_CHAT_ORIGIN_PAGE_LIMIT = 32;
// Budget 1 KiB for the response envelope, 1 KiB per approval's metadata,
// and 4 KiB per delivery including its escaped model label.
export const ROUTINE_CHAT_ORIGIN_RESPONSE_MAX_BYTES = 1024 + ROUTINE_CHAT_ORIGIN_PAGE_LIMIT * (
  botInteractionPayloadByteLimit({ kind: "approval", tool: "routine.activate" }) + 1024 + 4 * 1024
);

/** Presentation anchor stays separate from canonical approval/task/Chat identity. */
export const RoutineChatOriginPendingSchema = z.object({
  sourceChatId: CanonicalChatIdSchema, anchorMessageId: CanonicalChatMessageIdSchema,
  /** Opt-in timeline reads preserve the original approval creation time. */
  createdAt: IsoTimestampSchema.optional(),
  interaction: BotInteractionSchema,
}).strict();
export const RoutineChatOriginHistoryItemSchema = RoutineChatOriginPendingSchema.extend({
  decision: z.enum(["approve", "deny"]).optional(),
}).refine(({ interaction, decision }) =>
  interaction.kind === "approval" && interaction.status !== "pending"
  && (decision === undefined || interaction.status === "resolved"),
);
export const RoutineChatOriginViewSchema = z.object({
  sourceChatId: CanonicalChatIdSchema,
  pending: z.array(RoutineChatOriginPendingSchema).max(ROUTINE_CHAT_ORIGIN_PAGE_LIMIT),
  history: z.array(RoutineChatOriginHistoryItemSchema).max(ROUTINE_CHAT_ORIGIN_PAGE_LIMIT).optional(),
  deliveries: z.array(z.object({ messageId: CanonicalChatMessageIdSchema, receipt: RoutineChatReceiptPartSchema }).strict()).max(ROUTINE_CHAT_ORIGIN_PAGE_LIMIT),
  hasMore: z.boolean(), deliveryPending: z.boolean().default(false),
}).strict();
export type RoutineChatOriginPending = z.infer<typeof RoutineChatOriginPendingSchema>;
export type RoutineChatOriginHistoryItem = z.infer<typeof RoutineChatOriginHistoryItemSchema>;
export type RoutineChatOriginView = z.infer<typeof RoutineChatOriginViewSchema>;
