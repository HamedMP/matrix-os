import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";
/** Support accepts uncertain upstream liability; this never attests a charge. */
export const FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD = 20_000_000;
// Keep operator batch receipts within their existing wire/audit byte bounds.
// The owner inventory is bounded by captured liability, not record count.
const MAX_RECOVERY_BATCH_RECORDS = 2;
// Legacy unbound Relay/operator proof waits for the full 15-minute limit plus grace.
export const FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS = 16 * 60000;
const Reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Evidence = z.string().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
export const FundedAiExecutionRecoveryRequestSchema = z.object({
  expectedOwnerId: Reference,
  reservationId: Reference,
  tokenId: Reference,
  expectedRequestId: Reference,
  expectedStartedAt: IsoTimestampSchema,
  expectedExpiresAt: IsoTimestampSchema,
  maximumLiabilityMicrousd: z.number().int().positive().max(FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD),
  localRunId: Reference,
  localRunState: z.enum(["completed", "failed", "cancelled"]),
  localRunEndedAt: IsoTimestampSchema,
  evidenceRef: Evidence,
  reviewer: Evidence,
  acceptUnknownUpstreamLiability: z.literal(true),
}).strict().refine((value) => Date.parse(value.localRunEndedAt) >= Date.parse(value.expectedStartedAt), {
  path: ["localRunEndedAt"], message: "Terminal evidence must follow inference start",
});
export const FundedAiExecutionRecoveryResponseSchema = z.object({
  contractVersion: z.literal(1),
  executionAdmissionReleased: z.literal(true),
  usageKnown: z.literal(false),
  reservedMicrousd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maximumLiabilityMicrousd: z.number().int().positive().max(FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD),
  releasedAt: IsoTimestampSchema,
}).strict();
export type FundedAiExecutionRecoveryRequest = z.infer<typeof FundedAiExecutionRecoveryRequestSchema>;
/** Authenticated Relay evidence that its local execution ended; provider usage remains unknown. */
export const FundedAiTerminalOutcomeRequestSchema = z.object({
  contractVersion: z.literal(1), reservationId: Reference, tokenId: Reference, requestId: Reference,
  ownerId: Reference, machineId: Reference,
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  startedAt: IsoTimestampSchema, expiresAt: IsoTimestampSchema,
  executionId: Reference, terminalState: z.enum(["completed", "failed", "cancelled"]), terminalAt: IsoTimestampSchema,
  outcome: z.literal("usage_unknown"),
}).strict().refine((v) => Date.parse(v.terminalAt) >= Date.parse(v.startedAt), {
  path: ["terminalAt"], message: "Terminal evidence must follow start",
});
export const FundedAiTerminalOutcomeResponseSchema = z.object({
  contractVersion: z.literal(1), outcomeAccepted: z.literal(true), usageKnown: z.literal(false), receivedAt: IsoTimestampSchema,
}).strict();
export type FundedAiTerminalOutcomeRequest = z.infer<typeof FundedAiTerminalOutcomeRequestSchema>;
export type FundedAiTerminalOutcomeResponse = z.infer<typeof FundedAiTerminalOutcomeResponseSchema>;
export const FundedAiExecutionRecoveryBatchItemSchema = z.object({
  ownerId: Reference, machineId: Reference,
  runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  fundingKind: z.enum(["usage", "speech"]), reservationId: Reference, tokenId: Reference,
  expectedRequestId: Reference, expectedStartedAt: IsoTimestampSchema, expectedExpiresAt: IsoTimestampSchema,
  maximumLiabilityMicrousd: z.number().int().positive().max(FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD),
  authorizationSha256: z.string().regex(/^[a-f0-9]{64}$/), localRunId: Reference,
  localRunState: z.enum(["completed", "failed", "cancelled"]), localRunEndedAt: IsoTimestampSchema,
}).strict().refine((v) => Date.parse(v.localRunEndedAt) >= Date.parse(v.expectedStartedAt), { path: ["localRunEndedAt"], message: "Terminal evidence must follow start" });
export const FundedAiExecutionRecoveryBatchRequestSchema = z.object({
  expectedOwnerId: Reference, reviewer: Evidence, evidenceRef: Evidence, acceptUnknownUpstreamLiability: z.literal(true),
  reservations: z.array(FundedAiExecutionRecoveryBatchItemSchema).min(1).max(MAX_RECOVERY_BATCH_RECORDS),
}).strict().superRefine((v, ctx) => {
  if (v.reservations.some((r) => r.ownerId !== v.expectedOwnerId)
    || new Set(v.reservations.map((r) => r.reservationId)).size !== v.reservations.length
    || v.reservations.reduce((sum, r) => sum + r.maximumLiabilityMicrousd, 0) > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD) {
    ctx.addIssue({ code: "custom", path: ["reservations"], message: "Invalid owner, duplicate record or liability bound" });
  }
});
export const FundedAiExecutionRecoveryBatchResponseSchema = z.object({
  contractVersion: z.literal(2), executionAdmissionReleased: z.literal(true), usageKnown: z.literal(false),
  maximumLiabilityMicrousd: z.number().int().positive().max(FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD),
  reservations: z.array(FundedAiExecutionRecoveryResponseSchema.extend({ reservationId: Reference })).min(1).max(MAX_RECOVERY_BATCH_RECORDS),
}).strict();
export type FundedAiExecutionRecoveryBatchRequest = z.infer<typeof FundedAiExecutionRecoveryBatchRequestSchema>;
