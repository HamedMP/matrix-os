import { createHash } from "node:crypto";
import { FundedAiAuthorizationResponseSchema, FundedAiSettlementResponseSchema, IsoTimestampSchema } from "@matrix-os/contracts";
import { sql, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";
import { reconcileExpiredPromotionalCredit } from "./ai-funded-reservation-sources.js";

type Row = Selectable<AiFundedUsageReservationsTable>;
type Executor = PlatformDB["executor"];
const Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const AuditSchema = z.object({
  policy: z.literal("matrix-customer-credit-2026-11-04"),
  reservationId: z.string(), tokenId: z.string(), ownerId: z.string(), machineId: z.string(), runtimeSlot: z.string(),
  authorizationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reservedMicrousd: Money, promotionalReservedMicrousd: Money.nullable(), addonReservedMicrousd: Money.nullable(),
  maximumLiabilityMicrousd: Money.positive(), releasedMicrousd: Money,
  reason: z.enum(["gateway_failure", "usage_unknown", "expired_request", "legacy_expired_hold"]),
  releasedAt: IsoTimestampSchema,
}).strict();
export type CustomerChargeReleaseReason = z.infer<typeof AuditSchema>["reason"];

/** Used by the write constraint and bounded corruption probes before index exclusions. */
export function customerChargeReleaseBindingSql() {
  return sql<boolean>`COALESCE(
    customer_charge_release::jsonb ->> 'policy' = 'matrix-customer-credit-2026-11-04'
    AND customer_charge_release::jsonb ->> 'reservationId' = reservation_id
    AND customer_charge_release::jsonb ->> 'tokenId' = token_id
    AND customer_charge_release::jsonb ->> 'ownerId' = owner_id
    AND customer_charge_release::jsonb ->> 'machineId' = machine_id
    AND customer_charge_release::jsonb ->> 'runtimeSlot' = runtime_slot
    AND customer_charge_release::jsonb ->> 'authorizationSha256' = encode(sha256(convert_to(authorization_response, 'UTF8')), 'hex')
    AND (customer_charge_release::jsonb ->> 'reservedMicrousd')::bigint = reserved_microusd
    AND (customer_charge_release::jsonb ->> 'releasedMicrousd')::bigint = reserved_microusd
    AND (customer_charge_release::jsonb ->> 'promotionalReservedMicrousd')::bigint IS NOT DISTINCT FROM promotional_reserved_microusd
    AND (customer_charge_release::jsonb ->> 'addonReservedMicrousd')::bigint IS NOT DISTINCT FROM addon_reserved_microusd
    AND (customer_charge_release::jsonb ->> 'maximumLiabilityMicrousd')::bigint =
      COALESCE((authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint, reserved_microusd)
    AND customer_charge_release::jsonb ->> 'reason' IN ('gateway_failure', 'usage_unknown', 'expired_request', 'legacy_expired_hold')
    AND customer_charge_release::jsonb ->> 'releasedAt' = released_at
    AND ((status = 'expired' AND actual_microusd IS NULL AND settlement_response IS NULL)
      OR (status = 'settled' AND actual_microusd IS NOT NULL
        AND settlement_response::jsonb ->> 'status' = 'settled'
        AND (settlement_response::jsonb ->> 'actualCostMicrousd')::bigint = actual_microusd
        AND (settlement_response::jsonb ->> 'chargedCostMicrousd')::bigint = 0
        AND (settlement_response::jsonb ->> 'matrixAbsorbedMicrousd')::bigint = actual_microusd)), FALSE)`;
}

export async function assertReleasedRecoveryCharges(executor: Executor, ownerId: string) {
  const corrupt = await executor.selectFrom("ai_funded_usage_reservations").select("reservation_id")
    .where("owner_id", "=", ownerId).where("execution_admission_release", "is not", null)
    .where("customer_charge_release", "is not", null).where("actual_microusd", "is", null)
    .where(sql<boolean>`NOT (${customerChargeReleaseBindingSql()})`).limit(1).executeTakeFirst();
  if (corrupt) throw new AiFundedPolicyError("idempotency_conflict");
}

export function capturedAiAuthorization(row: Row) {
  try {
    const captured = FundedAiAuthorizationResponseSchema.parse(JSON.parse(row.authorization_response));
    if (captured.reservation.reservationId !== row.reservation_id || captured.reservation.requestId !== row.request_id
      || captured.reservation.modelId !== row.model_id || captured.reservation.reservedMicrousd !== exactInteger(row.reserved_microusd)
      || captured.identity.tokenId !== row.token_id || captured.identity.ownerId !== row.owner_id
      || captured.identity.machineId !== row.machine_id || captured.identity.runtimeSlot !== row.runtime_slot) {
      throw new AiFundedPolicyError("idempotency_conflict");
    }
    return captured;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
}

export function isPostpaidAuthorization(row: Row): boolean {
  const captured = z.object({ reservation: z.object({ billingPolicy: z.literal("postpaid").optional() }).passthrough().optional() })
    .passthrough().parse(JSON.parse(row.authorization_response));
  if (captured.reservation?.billingPolicy !== "postpaid") return false;
  capturedAiAuthorization(row);
  return true;
}

/** A permanent customer-charge disposition, independent of unknown provider expense. */
export function readCustomerChargeRelease(row: Row) {
  try {
    const audit = AuditSchema.parse(JSON.parse(row.customer_charge_release!));
    const captured = capturedAiAuthorization(row);
    if (audit.reservationId !== row.reservation_id || audit.tokenId !== row.token_id
      || audit.ownerId !== row.owner_id || audit.machineId !== row.machine_id || audit.runtimeSlot !== row.runtime_slot
      || audit.authorizationSha256 !== createHash("sha256").update(row.authorization_response).digest("hex")
      || audit.reservedMicrousd !== exactInteger(row.reserved_microusd)
      || audit.promotionalReservedMicrousd !== (row.promotional_reserved_microusd === null ? null : exactInteger(row.promotional_reserved_microusd))
      || audit.addonReservedMicrousd !== (row.addon_reserved_microusd === null ? null : exactInteger(row.addon_reserved_microusd))
      || audit.maximumLiabilityMicrousd !== (captured.reservation.maxCostMicrousd ?? captured.reservation.reservedMicrousd)
      || audit.releasedMicrousd !== audit.reservedMicrousd || audit.releasedAt !== row.released_at
      || !["expired", "settled"].includes(row.status)) {
      throw new AiFundedPolicyError("idempotency_conflict");
    }
    if (row.status === "expired" && (row.actual_microusd !== null || row.settlement_response !== null)) throw new AiFundedPolicyError("idempotency_conflict");
    if (row.status === "settled") {
      const settlement = FundedAiSettlementResponseSchema.parse(JSON.parse(row.settlement_response!));
      if (row.actual_microusd === null || settlement.actualCostMicrousd !== exactInteger(row.actual_microusd)
        || settlement.chargedCostMicrousd !== 0 || settlement.matrixAbsorbedMicrousd !== settlement.actualCostMicrousd) {
        throw new AiFundedPolicyError("idempotency_conflict");
      }
    }
    return audit;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
}

/** Caller owns the funded-owner lock and locked request; no actual usage is invented. */
export async function releaseCustomerCharge(executor: Executor, row: Row, reason: CustomerChargeReleaseReason, checkedAt: string) {
  if (row.customer_charge_release !== null) return readCustomerChargeRelease(row);
  if (!["reserved", "starting", "in_flight"].includes(row.status) || row.actual_microusd !== null || row.charge_waiver !== null) {
    throw new AiFundedPolicyError("reservation_closed");
  }
  const captured = capturedAiAuthorization(row);
  const reserved = exactInteger(row.reserved_microusd);
  const audit = AuditSchema.parse({ policy: "matrix-customer-credit-2026-11-04",
    reservationId: row.reservation_id, tokenId: row.token_id, ownerId: row.owner_id,
    machineId: row.machine_id, runtimeSlot: row.runtime_slot,
    authorizationSha256: createHash("sha256").update(row.authorization_response).digest("hex"),
    reservedMicrousd: reserved,
    promotionalReservedMicrousd: row.promotional_reserved_microusd === null ? null : exactInteger(row.promotional_reserved_microusd),
    addonReservedMicrousd: row.addon_reserved_microusd === null ? null : exactInteger(row.addon_reserved_microusd),
    maximumLiabilityMicrousd: captured.reservation.maxCostMicrousd ?? reserved,
    releasedMicrousd: reserved, reason, releasedAt: checkedAt });
  const released = await executor.updateTable("ai_funded_runtime_balances").set({
    reserved_microusd: sql<number>`reserved_microusd - ${reserved}`,
    month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${row.period_start}
      THEN month_reserved_microusd - ${reserved} ELSE month_reserved_microusd END`, updated_at: checkedAt,
  }).where("machine_id", "=", row.machine_id).where("owner_id", "=", row.owner_id)
    .where(sql<boolean>`reserved_microusd >= ${reserved}`)
    .where(sql<boolean>`month_period_start <> ${row.period_start} OR month_reserved_microusd >= ${reserved}`)
    .returning("machine_id").executeTakeFirst();
  if (!released) throw new Error("Funded AI balance invariant violated");
  await executor.updateTable("ai_funded_usage_reservations").set({ status: "expired", released_at: checkedAt,
    customer_charge_release: JSON.stringify(audit) }).where("reservation_id", "=", row.reservation_id)
    .where("status", "=", row.status).where("customer_charge_release", "is", null)
    .returning("reservation_id").executeTakeFirstOrThrow();
  // Closing the request first removes its old grant protection; normal expiry applies.
  await reconcileExpiredPromotionalCredit(executor, { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot }, checkedAt);
  return audit;
}
