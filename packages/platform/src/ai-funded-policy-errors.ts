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
  | "unauthorized";

export class AiFundedPolicyError extends Error {
  constructor(readonly code: AiFundedPolicyErrorCode) {
    super(code);
    this.name = "AiFundedPolicyError";
  }
}
