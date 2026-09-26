import { FundedAiRouteReadinessReceiptSchema, FundedAiRuntimeFundingSummaryResponseSchema, type AiProviderReadiness } from "@matrix-os/contracts";
import type { FundedAiFundingSummaryReader } from "./funded-ai-funding-summary-client.js";
import type { FundedAiRouteReadinessReader } from "./funded-ai-route-readiness-client.js";

// The funding-summary client owns its bounded 5s request. Keep this outer
// deadline slightly longer so a cold control plane gets the full request
// window while dependencies that ignore abort still cannot hang readiness.
const READINESS_DEADLINE_MS = 6_000;

export interface FundedAiReadiness {
  readiness: AiProviderReadiness;
  allowedModelIds: string[];
}
export interface FundedAiReadinessReader { read(options?: { signal?: AbortSignal }): Promise<FundedAiReadiness> }

export function createFundedAiReadinessReader(options: {
  summary: FundedAiFundingSummaryReader;
  routes?: FundedAiRouteReadinessReader;
  now?: () => Date;
}): FundedAiReadinessReader {
  const now = options.now ?? (() => new Date());
  let inFlight: Promise<FundedAiReadiness> | undefined;

  async function readFresh(callerSignal?: AbortSignal): Promise<FundedAiReadiness> {
    const checkedAt = now();
    const unavailable: FundedAiReadiness = {
      readiness: { state: "unavailable", checkedAt: checkedAt.toISOString(), staleAfter: null,
        action: "retry", safeReason: "provider_unavailable" },
      allowedModelIds: [],
    };
    if (!options.routes) return unavailable;
    const controller = new AbortController();
    // The controller cancels sibling work when either dependency settles with
    // an error; the platform timeout independently bounds the external fetch.
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) return unavailable;
      const deadline = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Funded readiness cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Funded readiness deadline exceeded"));
        }, READINESS_DEADLINE_MS);
      });
      const [raw, rawReceipt] = await Promise.race([Promise.all([
        options.summary.getFundingSummary({ signal }),
        options.routes.getRouteReadiness({ signal }),
      ]), deadline]);
      const { policy, funding } = FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw });
      const receipt = FundedAiRouteReadinessReceiptSchema.parse(rawReceipt);
      const current = now().getTime();
      signal.throwIfAborted();
      const ledgerAsOf = Date.parse(funding.asOf);
      if (!policy.enabled || Date.parse(policy.checkedAt) > current
        || Date.parse(policy.staleAfter) <= current || funding.remainingBudgetMicrousd === 0
        || ledgerAsOf > current + 60_000 || current - ledgerAsOf > 5 * 60_000) return unavailable;
      if (receipt.globalRevision !== policy.globalRevision || receipt.runtimeRevision !== policy.runtimeRevision
        || Date.parse(receipt.checkedAt) > current || Date.parse(receipt.staleAfter) <= current
        || receipt.readyModelIds.some((id) => !policy.allowedModelIds.includes(id))) return unavailable;
      const allowedModelIds = policy.allowedModelIds
        .filter((id) => receipt.readyModelIds.includes(id))
        .map((id) => id.replace(/^anthropic\//, ""));
      if (allowedModelIds.length === 0) return unavailable;
      const staleAfter = new Date(Math.min(Date.parse(policy.staleAfter), Date.parse(receipt.staleAfter), checkedAt.getTime() + 30_000)).toISOString();
      if (funding.remainingBalanceMicrousd === 0) return funding.topUpEnabled === true ? {
        readiness: { state: "unavailable", checkedAt: checkedAt.toISOString(),
          staleAfter,
          action: "retry", safeReason: "credit_required" },
        allowedModelIds,
      } : unavailable;
      return {
        readiness: { state: "ready", checkedAt: checkedAt.toISOString(),
          staleAfter,
          action: "none", safeReason: null },
        allowedModelIds,
      };
    } catch (error) {
      console.warn("[funded-ai] Readiness check unavailable:", error instanceof Error ? error.name : "UnknownError");
      return unavailable;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  return {
    read(call = {}) {
      // An execution observer owns cancellation; it cannot abort another
      // concurrent Settings observer's shared observation.
      if (call.signal) return readFresh(call.signal);
      // Share only concurrent observations for this runtime. Never retain a
      // settled authorization decision: the next read must see policy changes.
      inFlight ??= readFresh().finally(() => { inFlight = undefined; });
      return inFlight.then((result) => structuredClone(result));
    },
  };
}
