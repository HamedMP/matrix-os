import { IsoTimestampSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { Selectable } from "kysely";
import type { AiFundedUsageReservationsTable } from "../db.js";
import { AiFundedPolicyError } from "../ai-funded-policy-errors.js";

const Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Shape = { capability: z.literal("speech:transcribe"), policyRevision: z.string().min(1).max(160),
  fundingPolicy: z.literal("speech_monthly_v1").optional() };
const Legacy = z.object(Shape).strict();
export const PostpaidSpeechAuthorizationSchema = z.object({ ...Shape,
  reservation: z.object({ billingMode: z.literal("usage"), billingPolicy: z.literal("postpaid"),
    reservedMicrousd: z.literal(0), maxCostMicrousd: Money.positive() }).strict(),
  allowanceReservedMicrousd: Money, allowancePeriodStart: IsoTimestampSchema.nullable(),
}).strict().refine(value => value.fundingPolicy === "speech_monthly_v1"
  ? value.allowanceReservedMicrousd === value.reservation.maxCostMicrousd && value.allowancePeriodStart !== null
  : value.allowanceReservedMicrousd === 0 && value.allowancePeriodStart === null);
const Capture = z.union([PostpaidSpeechAuthorizationSchema, Legacy]);
export function isSpeechAuthorization(value: string): boolean {
  try { return JSON.parse(value)?.capability === "speech:transcribe"; }
  catch (error) { if (error instanceof SyntaxError) return false; throw error; }
}
export function isSpeechMonthlyAuthorization(value: string): boolean {
  try { return Capture.parse(JSON.parse(value)).fundingPolicy === "speech_monthly_v1"; }
  catch (error) { if (error instanceof SyntaxError || error instanceof z.ZodError) return false; throw error; }
}
export function readSpeechAuthorization(row: Selectable<AiFundedUsageReservationsTable>) {
  try {
    const captured = Capture.parse(JSON.parse(row.authorization_response));
    const postpaid = "reservation" in captured;
    const held = Number(row.reserved_microusd);
    if (!Number.isSafeInteger(held) || !/^speech_[a-f0-9]{48}$/.test(row.token_id)
      || (postpaid ? held !== 0 || (captured.fundingPolicy === "speech_monthly_v1" && captured.allowancePeriodStart !== row.period_start) : held <= 0)) throw new AiFundedPolicyError("idempotency_conflict");
    return { kind: "speech" as const, captured, postpaid,
      maximumCostMicrousd: postpaid ? captured.reservation.maxCostMicrousd : held,
      monthly: captured.fundingPolicy === "speech_monthly_v1",
      allowanceReservedMicrousd: postpaid ? captured.allowanceReservedMicrousd : captured.fundingPolicy ? held : 0,
      allowancePeriodStart: postpaid ? captured.allowancePeriodStart : captured.fundingPolicy ? row.period_start : null };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
}
export const SpeechSettlementReceiptSchema = z.object({ capability: z.literal("speech:transcribe"), billingPolicy: z.literal("postpaid"),
  status: z.literal("settled"), reservationId: z.string(), requestId: z.string(), tokenId: z.string(),
  actualCostMicrousd: Money, chargedCostMicrousd: Money, matrixAbsorbedMicrousd: Money,
  settledAt: IsoTimestampSchema,
}).strict().refine(value => value.chargedCostMicrousd + value.matrixAbsorbedMicrousd === value.actualCostMicrousd);
