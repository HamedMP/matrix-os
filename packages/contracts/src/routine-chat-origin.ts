import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatMessageIdSchema } from "#canonical-chat";
import { BotInteractionSchema } from "#bots/interactions";
import { RoutineChatReceiptPartSchema } from "#routine-chat-receipt";
export { RoutineChatReceiptPartSchema, type RoutineChatReceiptPart } from "#routine-chat-receipt";
/** Presentation anchor stays separate from canonical approval/task/Chat identity. */
export const RoutineChatOriginPendingSchema = z.object({
  sourceChatId: CanonicalChatIdSchema, anchorMessageId: CanonicalChatMessageIdSchema,
  interaction: BotInteractionSchema,
}).strict();
export const RoutineChatOriginViewSchema = z.object({
  sourceChatId: CanonicalChatIdSchema,
  pending: z.array(RoutineChatOriginPendingSchema).max(32),
  deliveries: z.array(z.object({ messageId: CanonicalChatMessageIdSchema, receipt: RoutineChatReceiptPartSchema }).strict()).max(32),
  hasMore: z.boolean(), deliveryPending: z.boolean().default(false),
}).strict();
export type RoutineChatOriginPending = z.infer<typeof RoutineChatOriginPendingSchema>;
export type RoutineChatOriginView = z.infer<typeof RoutineChatOriginViewSchema>;
