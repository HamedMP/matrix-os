import type { FundedAiPriorityReason } from "@matrix-os/contracts";

export type AiFundedPolicyErrorCode =
  | "access_disabled"
  | "budget_exceeded"
  | "busy"
  | "identity_mismatch"
  | "idempotency_conflict"
  | "insufficient_credit"
  | "model_not_allowed"
  | "over_settlement"
  | "rate_limited"
  | "reservation_expired"
  | "reservation_closed"
  | "revision_conflict"
  | "unauthorized"
  | "unavailable";

/** When a busy refusal clears: an ISO time and the whole seconds until it, from the policy clock. */
export interface AiFundedRetry {
  at: string;
  afterSeconds: number;
}

export class AiFundedPolicyError extends Error {
  constructor(
    readonly code: AiFundedPolicyErrorCode,
    readonly reason?: FundedAiPriorityReason,
    readonly retry?: AiFundedRetry,
  ) {
    super(code);
    this.name = "AiFundedPolicyError";
  }
}
