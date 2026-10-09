import { FundedAiSettlementResponseSchema, type JevProvenanceSchema } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { z } from "zod/v4";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger, fundingSummary } from "./ai-funded-metering-helpers.js";
import { readUsageWaiverAudit } from "./ai-funded-usage-waiver-audit.js";

/** Caller holds the reservation row lock. No owner-source debit or hold release occurs here. */
export async function settleWaivedUsage(executor: PlatformDB["executor"],
  row: Selectable<AiFundedUsageReservationsTable>, actual: number, monthlyBudget: number,
  checkedAt: string, provenance?: z.infer<typeof JevProvenanceSchema>,
  manualReview?: { expectedRequestId: string; evidenceRef: string; reviewer: string }) {
  const audit = readUsageWaiverAudit(row);
  const expected = audit.request.reservations.find((item) => item.reservationId === row.reservation_id)!;
  if (actual > expected.maximumLiabilityMicrousd) throw new AiFundedPolicyError("over_settlement");
  if (row.status === "settled") {
    if (exactInteger(row.actual_microusd) !== actual || row.resolved_model !== (provenance?.resolvedModel ?? null)
      || row.pricing_version !== (provenance?.pricingVersion ?? null)) throw new AiFundedPolicyError("idempotency_conflict");
    if (manualReview && (row.manual_review_evidence_ref !== manualReview.evidenceRef
      || row.manual_review_actor !== manualReview.reviewer)) throw new AiFundedPolicyError("idempotency_conflict");
    return FundedAiSettlementResponseSchema.parse(JSON.parse(row.settlement_response!));
  }
  if (row.status !== "waived") throw new AiFundedPolicyError("reservation_closed");
  const balance = await executor.selectFrom("ai_funded_runtime_balances").selectAll()
    .where("machine_id", "=", row.machine_id).where("owner_id", "=", row.owner_id)
    .where("runtime_slot", "=", row.runtime_slot).executeTakeFirstOrThrow();
  const funding = fundingSummary(balance, monthlyBudget, checkedAt);
  const response = FundedAiSettlementResponseSchema.parse({ contractVersion: 1,
    reservationId: row.reservation_id, requestId: row.request_id, tokenId: row.token_id,
    actualCostMicrousd: actual, chargedCostMicrousd: 0, matrixAbsorbedMicrousd: actual,
    // The entire hold was already released by the waiver. This receipt releases nothing again.
    releasedMicrousd: 0, remainingBalanceMicrousd: funding.remainingBalanceMicrousd,
    remainingBudgetMicrousd: funding.remainingBudgetMicrousd, funding, settledAt: checkedAt, status: "settled" });
  const updated = await executor.updateTable("ai_funded_usage_reservations").set({
    status: "settled", actual_microusd: actual, finalization_mode: "exact", settled_at: checkedAt,
    resolved_model: provenance?.resolvedModel ?? null, pricing_version: provenance?.pricingVersion ?? null,
    settlement_response: JSON.stringify(response),
    ...(manualReview ? { manual_review_evidence_ref: manualReview.evidenceRef,
      manual_review_actor: manualReview.reviewer, manual_reviewed_at: checkedAt } : {}),
  }).where("reservation_id", "=", row.reservation_id).where("token_id", "=", row.token_id)
    .where("status", "=", "waived").where("actual_microusd", "is", null)
    .where("charge_waiver", "=", row.charge_waiver!).returning("reservation_id").executeTakeFirst();
  if (!updated) throw new AiFundedPolicyError("revision_conflict");
  return response;
}
