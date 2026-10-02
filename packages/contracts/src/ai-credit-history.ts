import { z } from "zod/v4";

export const AiCreditHistoryQuerySchema = z.object({
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).default("primary"),
  limit: z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(20),
  cursor: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();

export const AiCreditHistoryEntrySchema = z.object({
  occurredAt: z.iso.datetime(),
  kind: z.enum(["usage", "credit", "adjustment"]),
  amountMicrousd: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  modelId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).nullable(),
}).strict();

export const AiCreditHistoryResponseSchema = z.object({
  entries: z.array(AiCreditHistoryEntrySchema).max(50),
  nextCursor: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
}).strict();
export type AiCreditHistoryEntry = z.infer<typeof AiCreditHistoryEntrySchema>;
export type AiCreditHistoryResponse = z.infer<typeof AiCreditHistoryResponseSchema>;
