import { FundedAiSettlementResponseSchema, type JevProvenanceSchema } from "@matrix-os/contracts";
import { sql, type Selectable } from "kysely";
import type { z } from "zod/v4";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { capturedAiAuthorization, readCustomerChargeRelease, releaseCustomerCharge } from "./ai-funded-customer-charge-release.js";
import { exactInteger, fundingSummary, recordUsageFunding, utcMonthStart } from "./ai-funded-metering-helpers.js";
import { debitPromotionalGrants, fundingSourceAvailability, reconcileExpiredPromotionalCredit, reserveFundingSources } from "./ai-funded-reservation-sources.js";

type Row = Selectable<AiFundedUsageReservationsTable>;
/** Owner lock and request lock cover live source selection, debit and once-only receipt. */
export async function settlePostpaidUsage(executor: PlatformDB["executor"], row: Row,
  actual: number, monthlyBudget: number, checkedAt: string,
  input: { customerCharge?: "waived"; jevProvenance?: z.infer<typeof JevProvenanceSchema>;
    manualReview?: { expectedRequestId: string; evidenceRef: string; reviewer: string } } = {}) {
  const captured = capturedAiAuthorization(row);
  const postpaid = captured.reservation.billingPolicy === "postpaid";
  if (row.started_at === null) throw new AiFundedPolicyError("reservation_closed");
  if (!postpaid && (row.customer_charge_release === null || input.customerCharge !== undefined)) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  if (actual > (captured.reservation.maxCostMicrousd ?? captured.reservation.reservedMicrousd)) throw new AiFundedPolicyError("over_settlement");
  if (row.customer_charge_release !== null) readCustomerChargeRelease(row);
  if (row.status === "settled") {
    if (exactInteger(row.actual_microusd) !== actual || row.resolved_model !== (input.jevProvenance?.resolvedModel ?? null)
      || row.pricing_version !== (input.jevProvenance?.pricingVersion ?? null)
      || (input.customerCharge === "waived" && row.customer_charge_release === null)
      || (input.manualReview && (row.manual_review_evidence_ref !== input.manualReview.evidenceRef
        || row.manual_review_actor !== input.manualReview.reviewer))) {
      throw new AiFundedPolicyError("idempotency_conflict");
    }
    return FundedAiSettlementResponseSchema.parse(JSON.parse(row.settlement_response!));
  }
  if (row.status !== "in_flight" && !(row.status === "expired" && row.customer_charge_release !== null)) {
    throw new AiFundedPolicyError("reservation_closed");
  }
  if (row.customer_charge_release === null && (input.customerCharge === "waived" || row.expires_at <= checkedAt)) {
    await releaseCustomerCharge(executor, row, input.customerCharge === "waived" ? "gateway_failure" : "expired_request", checkedAt);
    row = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", row.reservation_id).executeTakeFirstOrThrow();
  }
  const identity = { ownerId: row.owner_id, machineId: row.machine_id, runtimeSlot: row.runtime_slot };
  const period = utcMonthStart(new Date(checkedAt));
  await executor.updateTable("ai_funded_runtime_balances").set({ month_period_start: period,
    month_spent_microusd: sql<number>`CASE WHEN month_period_start = ${period} THEN month_spent_microusd ELSE 0 END`,
    month_reserved_microusd: sql<number>`CASE WHEN month_period_start = ${period} THEN month_reserved_microusd ELSE 0 END`,
    updated_at: checkedAt }).where("machine_id", "=", row.machine_id).execute();
  let balance = await reconcileExpiredPromotionalCredit(executor, identity, checkedAt);
  let promotionalDebit = 0, addonDebit = 0;
  if (row.customer_charge_release === null) {
    const sources = await fundingSourceAvailability(executor, identity, balance, checkedAt);
    const charge = Math.max(0, Math.min(actual, sources.availableMicrousd,
      exactInteger(balance.credit_balance_microusd) - exactInteger(balance.reserved_microusd) - exactInteger(balance.funding_shortfall_microusd),
      monthlyBudget - exactInteger(balance.month_spent_microusd) - exactInteger(balance.month_reserved_microusd)));
    const split = await reserveFundingSources(executor, identity, charge, balance, checkedAt);
    promotionalDebit = await debitPromotionalGrants(executor, identity, split.promotionalReservedMicrousd, checkedAt);
    addonDebit = split.addonReservedMicrousd;
  }
  const charged = promotionalDebit + addonDebit;
  // Customer reservation is zero (or its legacy hold was already released).
  // Account known charges in the completion month, never the request's old month.
  await recordUsageFunding(executor, { ...row, reserved_microusd: 0, period_start: period }, actual,
    promotionalDebit, addonDebit, checkedAt, true);
  balance = await reconcileExpiredPromotionalCredit(executor, identity, checkedAt);
  const funding = fundingSummary(balance, monthlyBudget, checkedAt);
  const response = FundedAiSettlementResponseSchema.parse({ contractVersion: 1,
    reservationId: row.reservation_id, requestId: row.request_id, tokenId: row.token_id,
    actualCostMicrousd: actual, chargedCostMicrousd: charged, matrixAbsorbedMicrousd: actual - charged,
    releasedMicrousd: 0, remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
    remainingBudgetMicrousd: funding.remainingBudgetMicrousd, funding, settledAt: checkedAt, status: "settled" });
  await executor.updateTable("ai_funded_usage_reservations").set({ status: "settled", actual_microusd: actual,
    settled_at: checkedAt, finalization_mode: "exact", resolved_model: input.jevProvenance?.resolvedModel ?? null,
    pricing_version: input.jevProvenance?.pricingVersion ?? null, settlement_response: JSON.stringify(response),
    ...(input.manualReview ? { manual_review_evidence_ref: input.manualReview.evidenceRef,
      manual_review_actor: input.manualReview.reviewer, manual_reviewed_at: checkedAt } : {}) })
    .where("reservation_id", "=", row.reservation_id).where("actual_microusd", "is", null)
    .where("status", "=", row.status).returning("reservation_id").executeTakeFirstOrThrow();
  return response;
}
