import type { FundedAiPriorityReason } from "@matrix-os/contracts";

export type AiFundedPolicyErrorCode =
  | "access_disabled"
  | "budget_exceeded"
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

export class AiFundedPolicyError extends Error {
  constructor(readonly code: AiFundedPolicyErrorCode, readonly reason?: FundedAiPriorityReason) {
    super(code);
    this.name = "AiFundedPolicyError";
  }
}
