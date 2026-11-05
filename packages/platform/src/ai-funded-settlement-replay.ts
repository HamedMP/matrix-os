import { FundedAiSettlementResponseSchema } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { AiFundedUsageReservationsTable } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";

/** Replays only an already settled receipt; never derives new expense or writes. */
export function replaySettledFundedUsage(row: Selectable<AiFundedUsageReservationsTable>, input: {
  actualCostMicrousd: number;
  jevProvenance?: { resolvedModel: string; pricingVersion: string };
  manualReview?: { evidenceRef: string; reviewer: string };
}) {
  if (exactInteger(row.actual_microusd) !== input.actualCostMicrousd
    || row.resolved_model !== (input.jevProvenance?.resolvedModel ?? null)
    || row.pricing_version !== (input.jevProvenance?.pricingVersion ?? null)
    || (input.manualReview && (row.manual_review_evidence_ref !== input.manualReview.evidenceRef
      || row.manual_review_actor !== input.manualReview.reviewer))) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  if (row.settlement_response === null) throw new Error("Settled reservation is missing its response");
  return {
    response: FundedAiSettlementResponseSchema.parse(JSON.parse(row.settlement_response)),
    finalizationMode: row.finalization_mode === "conservative" ? "conservative" as const : "exact" as const,
  };
}
