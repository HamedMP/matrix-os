import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";

const MAX_LEDGER_AGE_MS = 5 * 60_000;
const PREFLIGHT_DEADLINE_MS = 6_000;
const PROBE_MODELS = ["@cf/zai-org/glm-5.3-flash", "anthropic/claude-sonnet-5"] as const;

/** A new payment must be useful to this owner and exact computer. Zero balance is allowed. */
export async function isAiCreditCheckoutRouteHealthy(input: {
  repository: Pick<AiFundedPolicyRepository, "getRuntimeFundingSummary">;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  relayBaseUrl: string | undefined;
  relayControlToken: string | undefined;
  fetchFn?: typeof fetch;
  now?: () => Date;
  deadlineMs?: number;
}): Promise<boolean> {
  const controller = new AbortController();
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const base = new URL(input.relayBaseUrl ?? "");
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/"
      || base.search || base.hash || !input.relayControlToken || input.relayControlToken.length < 32) return false;
    const deadlineMs = input.deadlineMs ?? PREFLIGHT_DEADLINE_MS;
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => {
        expired = true;
        controller.abort();
        resolve(false);
      }, deadlineMs);
    });
    const check = async (): Promise<boolean> => {
      const now = (input.now ?? (() => new Date()))().getTime();
      const { policy, funding } = await input.repository.getRuntimeFundingSummary(input.identity);
      if (expired) return false;
      const checkedAt = Date.parse(policy.checkedAt);
      const staleAfter = Date.parse(policy.staleAfter);
      const ledgerAsOf = Date.parse(funding.asOf);
      if (!policy.enabled || policy.allowedModelIds.length === 0 || funding.remainingBudgetMicrousd === 0
        || !Number.isFinite(checkedAt) || checkedAt > now
        || !Number.isFinite(staleAfter) || staleAfter <= now
        || !Number.isFinite(ledgerAsOf) || ledgerAsOf > now + 60_000
        || now - ledgerAsOf > MAX_LEDGER_AGE_MS) return false;
      for (const model of PROBE_MODELS) {
        if (!policy.allowedModelIds.includes(model) || expired) continue;
        try {
          const url = new URL(`/ready?model=${encodeURIComponent(model)}`, base);
          const response = await (input.fetchFn ?? fetch)(url.toString(), {
            headers: { authorization: `Bearer ${input.relayControlToken}` },
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            continue;
          }
          const body: unknown = await response.json();
          if (!expired && body && typeof body === "object" && "ready" in body && body.ready === true) return true;
        } catch (error) {
          console.warn("[billing] Matrix AI model probe unavailable:", error instanceof Error ? error.name : typeof error);
        }
      }
      return false;
    };
    return await Promise.race([check(), deadline]);
  } catch (error) {
    console.warn("[billing] Matrix AI checkout readiness unavailable:", error instanceof Error ? error.name : typeof error);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
  }
}
