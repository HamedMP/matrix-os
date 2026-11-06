import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";
import { canonicalReferenceId, canonicalSafeLabel } from "#canonical-chat-primitives";
/** Server-authored provenance. Never accepted in a user turn or as tool authority. */
export const RoutineChatReceiptPartSchema = z.object({
  type: z.literal("routine_receipt"), engine: z.literal("matrix"),
  routineId: z.string().regex(/^rt_[a-f0-9]{24}$/), fireId: z.string().regex(/^fire_[a-f0-9]{24}$/),
  kind: z.enum(["status", "output"]).default("output"),
  stop: z.literal("unconfirmed").optional(),
  attempt: z.number().int().min(0).max(1000),
  status: z.enum(["completed", "failed", "cancelled", "unknown", "missed", "skipped"]),
  scheduledFor: IsoTimestampSchema,
  canonicalChatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/),
  canonicalTaskId: canonicalReferenceId(128),
  canonicalRunId: z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/).optional(),
  canonicalMessageId: z.string().regex(/^msg_[A-Za-z0-9_-]{1,128}$/).optional(),
  model: canonicalSafeLabel(240, 960),
}).strict();
export type RoutineChatReceiptPart = z.infer<typeof RoutineChatReceiptPartSchema>;
