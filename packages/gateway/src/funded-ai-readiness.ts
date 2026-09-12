import { FundedAiRuntimeFundingSummaryResponseSchema, type AiProviderReadiness } from "@matrix-os/contracts";
import type { FundedAiFundingSummaryReader } from "./funded-ai-funding-summary-client.js";

export interface FundedAiReadiness {
  readiness: AiProviderReadiness;
  allowedModelIds: string[];
}
export interface FundedAiReadinessReader { read(): Promise<FundedAiReadiness> }

export function createFundedAiReadinessReader(options: {
  relayBaseUrl: string;
  summary: FundedAiFundingSummaryReader;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): FundedAiReadinessReader {
  // Operator configuration, never a user-supplied URL. No redirects are permitted.
  const healthUrl = new URL("/health", options.relayBaseUrl);
  if (healthUrl.protocol !== "https:" || healthUrl.username || healthUrl.password) {
    throw new Error("Invalid funded relay health configuration");
  }
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  let inFlight: Promise<FundedAiReadiness> | undefined;

  async function readFresh(): Promise<FundedAiReadiness> {
    const checkedAt = now();
    const unavailable: FundedAiReadiness = {
      readiness: { state: "unavailable", checkedAt: checkedAt.toISOString(), staleAfter: null,
        action: "retry", safeReason: "provider_unavailable" },
      allowedModelIds: [],
    };
    const controller = new AbortController();
    const signal = controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Funded readiness deadline exceeded"));
        }, 2_000);
      });
      const [raw, healthy] = await Promise.race([Promise.all([
        options.summary.getFundingSummary({ signal }),
        fetchFn(healthUrl.toString(), { redirect: "error", signal }).then(async (response) => {
          await response.body?.cancel();
          return response.ok;
        }),
      ]), deadline]);
      const { policy, funding } = FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw });
      const current = now().getTime();
      if (!healthy || !policy.enabled || Date.parse(policy.checkedAt) > current
        || Date.parse(policy.staleAfter) <= current || funding.remainingBalanceMicrousd === 0
        || funding.remainingBudgetMicrousd === 0) return unavailable;
      const allowedModelIds = policy.allowedModelIds.map((id) => id.replace(/^anthropic\//, ""));
      if (allowedModelIds.length === 0) return unavailable;
      return {
        readiness: { state: "ready", checkedAt: checkedAt.toISOString(),
          staleAfter: new Date(Math.min(Date.parse(policy.staleAfter), checkedAt.getTime() + 30_000)).toISOString(),
          action: "none", safeReason: null },
        allowedModelIds,
      };
    } catch (error) {
      console.warn("[funded-ai] Readiness check unavailable:", error instanceof Error ? error.name : "UnknownError");
      return unavailable;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    }
  }

  return {
    read() {
      // Share only concurrent observations for this runtime. Never retain a
      // settled authorization decision: the next read must see policy changes.
      inFlight ??= readFresh().finally(() => { inFlight = undefined; });
      return inFlight.then((result) => structuredClone(result));
    },
  };
}
