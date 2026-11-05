import type { FundedAiAuthorizationResponse, FundedAiFinalizationRequest } from "@matrix-os/contracts";
import type { FundedFinalization } from "./funded-relay-usage.js";

/** New requests never silently fall back to customer credit holds. */
export function postpaidAuthorizationMatches(
  reservation: FundedAiAuthorizationResponse["reservation"],
  input: { requestId: string; modelId: string; maxCostMicrousd: number },
): boolean {
  return reservation.requestId === input.requestId && reservation.modelId === input.modelId
    && reservation.billingMode === "usage" && reservation.billingPolicy === "postpaid"
    && reservation.reservedMicrousd === 0 && reservation.maxCostMicrousd === input.maxCostMicrousd;
}

/** An exact provider cost is distinct from permission to debit the customer. */
export function postpaidExactFinalization(
  locator: { reservationId: string; tokenId: string },
  result: Extract<FundedFinalization, { mode: "exact" }>,
  terminalState: "completed" | "failed" | "cancelled",
): FundedAiFinalizationRequest {
  return { ...locator, ...result, ...(terminalState === "completed" ? {} : { customerCharge: "waived" as const }) };
}
