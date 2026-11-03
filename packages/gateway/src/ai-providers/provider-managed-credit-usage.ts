import type { FundedAiFundingSummary, FundedAiChatAvailability, ProviderUsage } from "@matrix-os/contracts";

/** Shared ledger arithmetic; no provider inventory or execution readiness reads. */
export function projectManagedCreditUsage(fundingSummary: FundedAiFundingSummary, chatAvailability: FundedAiChatAvailability | undefined, now: Date): Extract<ProviderUsage, {kind: "managed_credit"}> {
  return {
    kind: "managed_credit" as const,
    authority: "matrix_ledger" as const,
    state: fundingState(fundingSummary.asOf, now),
    scope: "owner_entitlement" as const,
    currency: "USD",
    usedMicrousd: fundingSummary.settledThisMonthMicrousd,
    remainingMicrousd: Math.min(
      fundingSummary.remainingBalanceMicrousd,
      fundingSummary.remainingBudgetMicrousd,
    ),
    limitMicrousd: fundingSummary.monthlyBudgetMicrousd,
    periodStartedAt: fundingSummary.periodStart,
    resetsAt: nextUtcMonth(fundingSummary.periodStart),
    asOf: fundingSummary.asOf,
    ...(chatAvailability ? { chatAvailability } : {}),
    ...(fundingSummary.previewQuota ? { previewQuota: fundingSummary.previewQuota } : {}),
    credit: {
      promotionalBalanceMicrousd: fundingSummary.promotionalBalanceMicrousd,
      addonBalanceMicrousd: fundingSummary.addonBalanceMicrousd,
      creditBalanceMicrousd: fundingSummary.creditBalanceMicrousd,
      reservedMicrousd: fundingSummary.reservedMicrousd,
      ...(fundingSummary.fundingShortfallMicrousd === undefined
        ? {}
        : { fundingShortfallMicrousd: fundingSummary.fundingShortfallMicrousd }),
      remainingBalanceMicrousd: fundingSummary.remainingBalanceMicrousd,
    },
    budget: {
      monthlyBudgetMicrousd: fundingSummary.monthlyBudgetMicrousd,
      settledThisMonthMicrousd: fundingSummary.settledThisMonthMicrousd,
      reservedThisMonthMicrousd: fundingSummary.reservedThisMonthMicrousd,
      remainingBudgetMicrousd: fundingSummary.remainingBudgetMicrousd,
    },
  };
}

function nextUtcMonth(periodStart: string): string {
  const start = new Date(periodStart);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
}
function fundingState(asOf: string, now: Date): "current" | "stale" {
  const age = now.getTime() - Date.parse(asOf);
  return Number.isFinite(age) && age >= -60_000 && age <= 5 * 60_000 ? "current" : "stale";
}
