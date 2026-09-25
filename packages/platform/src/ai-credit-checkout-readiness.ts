import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import { FUNDED_PROBE_MODELS, type FundedModelProbeService } from "./ai-funded-model-probes.js";

const MAX_LEDGER_AGE_MS = 5 * 60_000;
const PREFLIGHT_DEADLINE_MS = 6_000;
const MAX_PENDING_FUNDING_READS = 4;
const pendingFundingReads = new Set<Promise<unknown>>();

/** A new payment must be useful to this owner and exact computer. Zero balance is allowed. */
export async function isAiCreditCheckoutRouteHealthy(input: {
  repository: Pick<AiFundedPolicyRepository, "getCheckoutFundingSummary">;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  modelProbes?: FundedModelProbeService;
  now?: () => Date;
  deadlineMs?: number;
}): Promise<boolean> {
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!input.modelProbes || pendingFundingReads.size >= MAX_PENDING_FUNDING_READS) return false;
    const deadlineMs = input.deadlineMs ?? PREFLIGHT_DEADLINE_MS;
    const deadlineAtMs = Date.now() + deadlineMs;
    const read = () => {
      if (expired || pendingFundingReads.size >= MAX_PENDING_FUNDING_READS) {
        throw new Error("Checkout funding read unavailable");
      }
      const pending = input.repository.getCheckoutFundingSummary(input.identity, deadlineAtMs);
      pendingFundingReads.add(pending);
      void pending.then(
        () => { pendingFundingReads.delete(pending); },
        () => { pendingFundingReads.delete(pending); },
      );
      return pending;
    };
    const fundingRead = read();
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => { expired = true; resolve(false); }, deadlineMs);
    });
    const check = async (): Promise<boolean> => {
      const first = await fundingRead;
      const current = (input.now ?? (() => new Date()))().getTime();
      if (expired || !validFunding(first, current)) return false;
      for (const model of FUNDED_PROBE_MODELS) {
        if (!first.policy.allowedModelIds.includes(model) || expired) continue;
        const result = await input.modelProbes!.probe(model);
        const afterProbe = (input.now ?? (() => new Date()))().getTime();
        if (!result.ready || expired || Date.parse(result.checkedAt) > afterProbe
          || Date.parse(result.staleAfter) <= afterProbe) continue;
        // Policy or funding may change while the paid model probe is running.
        // Re-read the owner/runtime without granting credit before checkout.
        const latest = await read();
        const latestNow = (input.now ?? (() => new Date()))().getTime();
        if (!expired && validFunding(latest, latestNow)
          && latest.policy.globalRevision === first.policy.globalRevision
          && latest.policy.runtimeRevision === first.policy.runtimeRevision
          && latest.policy.allowedModelIds.includes(model)) return true;
        return false;
      }
      return false;
    };
    return await Promise.race([check(), deadline]);
  } catch (error) {
    console.warn("[billing] Matrix AI checkout readiness unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validFunding(state: Awaited<ReturnType<AiFundedPolicyRepository["getCheckoutFundingSummary"]>>, now: number): boolean {
  const { policy, funding } = state;
  const checkedAt = Date.parse(policy.checkedAt);
  const staleAfter = Date.parse(policy.staleAfter);
  const ledgerAsOf = Date.parse(funding.asOf);
  return policy.enabled && policy.allowedModelIds.length > 0 && funding.remainingBudgetMicrousd > 0
    && Number.isFinite(checkedAt) && checkedAt <= now
    && Number.isFinite(staleAfter) && staleAfter > now
    && Number.isFinite(ledgerAsOf) && ledgerAsOf <= now + 60_000
    && now - ledgerAsOf <= MAX_LEDGER_AGE_MS;
}
