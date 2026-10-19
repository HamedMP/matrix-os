import type { ProviderManagedCreditObservation } from "@matrix-os/contracts";
import { disconnectedSnapshot } from "./chat-provider-settings-fixture";
export const start = "2026-10-14T08:00:00.000Z";
export function observation(remaining = 4_000_000): ProviderManagedCreditObservation {
  const asOf = new Date().toISOString();
  return { contractVersion: 1, revision: 1, gatewayPolicyAccessSourceId: "matrix_included", topUpEnabled: false,
    policy: { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: ["anthropic/sonnet"], monthlyBudgetMicrousd: 5_000_000, checkedAt: asOf, staleAfter: new Date(Date.now() + 60_000).toISOString() },
    usage: { kind: "managed_credit", authority: "matrix_ledger", state: "current", scope: "owner_entitlement", currency: "USD",
      usedMicrousd: 5_000_000 - remaining, remainingMicrousd: remaining, limitMicrousd: 5_000_000,
      periodStartedAt: start, resetsAt: null, asOf,
      chatAvailability: { contractVersion: 1, asOf, eligibleBalanceMicrousd: remaining, availableBalanceMicrousd: remaining },
      credit: { promotionalBalanceMicrousd: remaining, addonBalanceMicrousd: 0, creditBalanceMicrousd: remaining, reservedMicrousd: 0, remainingBalanceMicrousd: remaining },
      budget: { monthlyBudgetMicrousd: 5_000_000, settledThisMonthMicrousd: 5_000_000 - remaining, reservedThisMonthMicrousd: 0, remainingBudgetMicrousd: remaining } } };
}
export function snapshot() {
  const value = disconnectedSnapshot();
  value.accessSources = [{ id: "matrix_included", kind: "matrix_gateway", fundingKind: "matrix_included", providerId: "anthropic", accountId: null, displayName: "Matrix AI", eligibleModelIds: ["sonnet"], readiness: { state: "ready", checkedAt: start, staleAfter: null, action: "none", safeReason: null }, usage: observation().usage }];
  value.gatewayPolicy = { accessSourceId: "matrix_included", allowedModelIds: ["sonnet"], monthlyBudgetMicrousd: 5_000_000, topUpEnabled: false };
  return value;
}
