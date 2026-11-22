import { FundedAiSettlementResponseSchema, type FundedAiUpstreamProvenanceSchema, type JevProvenanceSchema } from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import type { z } from "zod/v4";
import type { AiFundedUsageReservationsTable } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";

export type StoredUpstreamProvenance = z.infer<typeof FundedAiUpstreamProvenanceSchema>;

export function provenanceColumns(
  provenance: StoredUpstreamProvenance | z.infer<typeof JevProvenanceSchema> | undefined,
) {
  return {
    upstream: provenance && "upstream" in provenance ? provenance.upstream : null,
    route_id: provenance && "routeId" in provenance ? provenance.routeId : null,
    resolved_model: provenance?.resolvedModel ?? null,
    inference_profile: provenance && "inferenceProfile" in provenance ? provenance.inferenceProfile ?? null : null,
    region: provenance && "region" in provenance ? provenance.region ?? null : null,
    pricing_version: provenance?.pricingVersion ?? null,
    provider_request_id: provenance && "providerRequestId" in provenance ? provenance.providerRequestId ?? null : null,
  };
}

export function storedProvenanceMatches(
  row: {
    upstream: string | null; route_id: string | null; resolved_model: string | null;
    inference_profile: string | null; region: string | null; pricing_version: string | null;
    provider_request_id: string | null;
  },
  provenance: StoredUpstreamProvenance | z.infer<typeof JevProvenanceSchema> | undefined,
): boolean {
  const expected = provenanceColumns(provenance);
  return Object.entries(expected).every(([key, value]) => row[key as keyof typeof expected] === value);
}
/** Replays only an already settled receipt; never derives new expense or writes. */
export function replaySettledFundedUsage(row: Selectable<AiFundedUsageReservationsTable>, input: {
  actualCostMicrousd: number;
  jevProvenance?: z.infer<typeof JevProvenanceSchema>;
  upstreamProvenance?: StoredUpstreamProvenance;
  manualReview?: { evidenceRef: string; reviewer: string };
}) {
  if (exactInteger(row.actual_microusd) !== input.actualCostMicrousd
    || !storedProvenanceMatches(row, input.jevProvenance ?? input.upstreamProvenance)
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
