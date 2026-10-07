import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";

/** Support accepts uncertain upstream liability; this never attests a charge. */
export const FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD = 500_000;
/** Maximum owner-wide actual-null audited obligations, independently of live work. */
export const FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN = 2;
// Relay permits at most 15 minutes, independent of its configured shorter limit.
export const FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS = 16 * 60_000;
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
