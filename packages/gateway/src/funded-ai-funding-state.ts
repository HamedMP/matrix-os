import type { AiProviderReadiness, FundedAiFundingSummary, FundedAiChatAvailability } from "@matrix-os/contracts";

/** Only call with a schema-validated, current owner funding summary. No route verification is implied. */
export function fundedAiFundingBarrier(funding: FundedAiFundingSummary, chatAvailability: FundedAiChatAvailability): Pick<AiProviderReadiness, "safeReason" | "action"> | undefined {
  const balanceBlocked = chatAvailability.availableBalanceMicrousd === 0;
  const budgetBlocked = funding.remainingBudgetMicrousd === 0;
  if (!balanceBlocked && !budgetBlocked) return undefined;
  const balanceBeforeHolds = Math.min(chatAvailability.eligibleBalanceMicrousd,
    Math.max(0, funding.creditBalanceMicrousd - (funding.fundingShortfallMicrousd ?? 0)));
  const budgetBeforeHolds = Math.max(0, funding.monthlyBudgetMicrousd - funding.settledThisMonthMicrousd);
  // Every exhausted funding dimension must have usable capacity before holds;
  // a simultaneous genuine exhaustion must not be explained away by a hold.
  if ((!balanceBlocked || funding.reservedMicrousd > 0 && balanceBeforeHolds > 0)
    && (!budgetBlocked || funding.reservedThisMonthMicrousd > 0 && budgetBeforeHolds > 0)) {
    return { safeReason: "credit_reserved", action: "retry" };
  }
  // Match admission: a settled monthly-budget exhaustion cannot be fixed by
  // purchasing credit, even when the credit dimension is also exhausted.
  if (budgetBlocked && budgetBeforeHolds === 0) {
    return { safeReason: "budget_exceeded", action: "contact_owner" };
  }
  return balanceBlocked && balanceBeforeHolds === 0
    ? { safeReason: "credit_required", action: "retry" }
    : { safeReason: "policy", action: "contact_owner" };
}
