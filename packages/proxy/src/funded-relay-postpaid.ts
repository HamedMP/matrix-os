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

/**
 * A free runtime's prepaid usage hold: usage billing with no postpaid policy, and a positive hold
 * no larger than the request's liability ceiling. Settlement debits at most that hold.
 */
export function prepaidUsageAuthorizationMatches(
  reservation: FundedAiAuthorizationResponse["reservation"],
  input: { requestId: string; modelId: string; maxCostMicrousd: number },
): boolean {
  return reservation.requestId === input.requestId && reservation.modelId === input.modelId
    && reservation.billingMode === "usage" && reservation.billingPolicy === undefined
    && reservation.reservedMicrousd > 0 && reservation.reservedMicrousd <= input.maxCostMicrousd
    && reservation.maxCostMicrousd === input.maxCostMicrousd;
}

/** An exact provider cost is distinct from permission to debit the customer. */
export function postpaidExactFinalization(
  locator: { reservationId: string; tokenId: string },
  result: Extract<FundedFinalization, { mode: "exact" }>,
  terminalState: "completed" | "failed" | "cancelled",
): FundedAiFinalizationRequest {
  return { ...locator, ...result, ...(terminalState === "completed" ? {} : { customerCharge: "waived" as const }) };
}

/** The relay's billing choice (ENG-520 P7): a free runtime's prepaid hold, or zero-hold postpaid for every other runtime. */
export function customerAuthorizationMatches(
  customerBilling: "prepaid" | undefined,
  reservation: FundedAiAuthorizationResponse["reservation"],
  input: { requestId: string; modelId: string; maxCostMicrousd: number },
): boolean {
  return customerBilling === "prepaid"
    ? prepaidUsageAuthorizationMatches(reservation, input) : postpaidAuthorizationMatches(reservation, input);
}

/** A prepaid hold settles at the exact cost, capped at the hold; it carries no postpaid customer-charge waiver. */
export function customerExactFinalization(
  customerBilling: "prepaid" | undefined,
  locator: { reservationId: string; tokenId: string },
  result: Extract<FundedFinalization, { mode: "exact" }>,
  terminalState: "completed" | "failed" | "cancelled",
): FundedAiFinalizationRequest {
  return customerBilling === "prepaid" ? { ...locator, ...result } : postpaidExactFinalization(locator, result, terminalState);
}
