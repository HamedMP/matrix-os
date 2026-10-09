import { z } from "zod/v4";
import { JevInboxGmailIdSchema } from "#jev";

export const JevInboxReceiptSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const JevInboxBatchJobIdSchema = z.string().regex(/^jev_batch_[a-f0-9]{32}$/);
export const JevSingleInboxInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("discover") }),
  z.strictObject({ operation: z.literal("select"), receipt: JevInboxReceiptSchema, threadId: JevInboxGmailIdSchema }),
  z.strictObject({ operation: z.literal("evaluate"), receipt: JevInboxReceiptSchema }),
]);
export const JevInboxBatchInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("batch_start"), maxThreads: z.number().int().min(1).max(10000).optional() }),
  z.strictObject({ operation: z.literal("batch_next"), jobId: JevInboxBatchJobIdSchema, revision: z.number().int().min(1) }),
  z.strictObject({ operation: z.literal("batch_resume"), jobId: JevInboxBatchJobIdSchema }),
  z.strictObject({ operation: z.literal("batch_status"), jobId: JevInboxBatchJobIdSchema.optional() }),
]);
/** Only operation arguments: owner, Gmail account, grant and run authority come from the gateway binding. */
export const JevInboxInputSchema = z.union([JevSingleInboxInputSchema, JevInboxBatchInputSchema]);
export type JevInboxInput = z.infer<typeof JevInboxInputSchema>;
