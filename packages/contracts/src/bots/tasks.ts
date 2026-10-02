import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { IsoTimestampSchema } from "#contract-primitives";
import { BotIdSchema, BotRevisionSchema, BotTaskIdSchema } from "#bots/ids";

export const BotTaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_person",
  "waiting_capacity",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

/** Allowlisted codes only; renderers map them to copy and never show raw errors. */
export const BotBlockedReasonSchema = z.enum([
  "root_unavailable",
  "grant_revoked",
  "budget_exhausted",
  "tool_unavailable",
  "model_unavailable",
  "funds_unavailable",
  "capacity_unavailable",
  "deadline_reached",
  "policy_denied",
]);

export const BotTaskSummarySchema = z.object({
  taskId: BotTaskIdSchema,
  chatId: CanonicalChatIdSchema,
  agentId: BotIdSchema,
  status: BotTaskStatusSchema,
  blockedReason: BotBlockedReasonSchema.optional(),
  revision: BotRevisionSchema,
  updatedAt: IsoTimestampSchema,
}).strict();
export const BotTaskListResponseSchema = z.object({ tasks: z.array(BotTaskSummarySchema).max(20) }).strict();

export type BotTaskStatus = z.infer<typeof BotTaskStatusSchema>;
export type BotBlockedReason = z.infer<typeof BotBlockedReasonSchema>;
export type BotTaskSummary = z.infer<typeof BotTaskSummarySchema>;
