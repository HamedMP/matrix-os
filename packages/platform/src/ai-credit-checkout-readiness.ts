import { FUNDED_AI_READINESS_TIMEOUTS } from "@matrix-os/contracts";
import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import { FUNDED_PROBE_MODELS, type FundedModelProbeService } from "./ai-funded-model-probes.js";

const MAX_LEDGER_AGE_MS = 5 * 60_000;
const MAX_PENDING_FUNDING_READS = 4;
const pendingFundingReads = new Set<Promise<unknown>>();

/** A new payment must be useful to this owner and exact computer. Zero balance is allowed. */
export async function isAiCreditCheckoutRouteHealthy(input: {
  repository: Pick<AiFundedPolicyRepository, "getCheckoutFundingSummary">;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  modelProbes?: FundedModelProbeService;
  now?: () => Date;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let cancel: ((value: false) => void) | undefined;
  const onAbort = () => { expired = true; controller.abort(); cancel?.(false); };
  try {
    if (!input.modelProbes || input.signal?.aborted
      || pendingFundingReads.size >= MAX_PENDING_FUNDING_READS) return false;
    const cancelled = new Promise<false>(resolve => { cancel = resolve; });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const deadlineMs = input.deadlineMs ?? FUNDED_AI_READINESS_TIMEOUTS.platformRouteMs;
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
      timeout = setTimeout(() => { expired = true; controller.abort(); resolve(false); }, deadlineMs);
    });
    const check = async (): Promise<boolean> => {
      const first = await fundingRead;
      const current = (input.now ?? (() => new Date()))().getTime();
      if (expired || !validFunding(first, current)) return false;
      // This fixed generic catalog bounds concurrency to two. A slow failed
      // model must not consume a healthy alternative's shared request window.
      const eligible = FUNDED_PROBE_MODELS.filter(model => first.policy.allowedModelIds.includes(model));
      return await Promise.any(eligible.map(async model => {
        const result = await input.modelProbes!.probe(model, { signal: controller.signal, deadlineAtMs });
        const afterProbe = (input.now ?? (() => new Date()))().getTime();
        if (!result.ready || expired || !(Date.parse(result.checkedAt) <= afterProbe)
          || !(Date.parse(result.staleAfter) > afterProbe)) throw new Error("Funded model unavailable");
        // Each ready candidate must complete its own final validation. An
        // early result expiring during its read cannot discard a fresh peer.
        const latest = await read();
        const latestNow = (input.now ?? (() => new Date()))().getTime();
        if (expired || !latest.policy.enabled
          || latest.policy.globalRevision !== first.policy.globalRevision
          || latest.policy.runtimeRevision !== first.policy.runtimeRevision) return false;
        if (!validFunding(latest, latestNow) || !latest.policy.allowedModelIds.includes(model)
          || !(Date.parse(result.checkedAt) <= latestNow) || !(Date.parse(result.staleAfter) > latestNow)) {
          throw new Error("Funded model unavailable");
        }
        return true;
      }));
    };
    return await Promise.race([check(), deadline, cancelled]);
  } catch (error) {
    console.warn("[billing] Matrix AI checkout readiness unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
    controller.abort();
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
