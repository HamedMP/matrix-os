import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";

const MAX_LEDGER_AGE_MS = 5 * 60_000;

/** A new payment must be useful to this owner and exact computer. Zero balance is allowed. */
export async function isAiCreditCheckoutRouteHealthy(input: {
  repository: Pick<AiFundedPolicyRepository, "getRuntimeFundingSummary">;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  relayBaseUrl: string | undefined;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): Promise<boolean> {
  try {
    const url = new URL("/health", input.relayBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const now = (input.now ?? (() => new Date()))().getTime();
    const { policy, funding } = await input.repository.getRuntimeFundingSummary(input.identity);
    const checkedAt = Date.parse(policy.checkedAt);
    const staleAfter = Date.parse(policy.staleAfter);
    const ledgerAsOf = Date.parse(funding.asOf);
    if (!policy.enabled || policy.allowedModelIds.length === 0 || funding.remainingBudgetMicrousd === 0
      || !Number.isFinite(checkedAt) || checkedAt > now
      || !Number.isFinite(staleAfter) || staleAfter <= now
      || !Number.isFinite(ledgerAsOf) || ledgerAsOf > now + 60_000
      || now - ledgerAsOf > MAX_LEDGER_AGE_MS) return false;
    const response = await (input.fetchFn ?? fetch)(url.toString(), {
      redirect: "error", signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch (error) {
    console.warn("[billing] Matrix AI checkout readiness unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
