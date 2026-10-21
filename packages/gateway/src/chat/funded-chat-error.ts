import { canonicalChatSafeFailureReason, type CanonicalChatSafeError, type CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";

export type FundedChatFailureReason = "insufficient_credit" | "budget_exceeded";

/** Fixed reviewed copy shared by preflight and trusted, run-scoped broker rejection. */
export function fundedChatError(code: FundedChatFailureReason | "credit_reserved"): CanonicalChatSafeError {
  return { code, safeMessage: canonicalChatSafeFailureReason(code)!, retryable: false, recoveryActions: ["select_provider"] };
}

export function fundedSelectionError(instance: CanonicalProviderInstanceDescriptor | undefined): CanonicalChatSafeError | undefined {
  if (instance?.id !== "matrix_pi_default" || instance.driverKind !== "matrix_pi" || instance.unavailabilityReason) return undefined;
  if (instance.connectionState === "credit_required") return fundedChatError("insufficient_credit");
  if (instance.connectionState === "credit_reserved") return fundedChatError("credit_reserved");
  if (instance.connectionState === "budget_exceeded") return fundedChatError("budget_exceeded");
  return undefined;
}
