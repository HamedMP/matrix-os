import { FundedAiRouteReadinessReceiptSchema, type FundedAiRouteReadinessReceipt } from "@matrix-os/contracts";
import type { FundedAiRuntimeConfig } from "./funded-ai-credential-manager.js";
import { readBoundedFundedJson } from "./funded-ai-funding-summary-client.js";

export interface FundedAiRouteReadinessReader {
  getRouteReadiness(options?: { signal?: AbortSignal }): Promise<FundedAiRouteReadinessReceipt>;
}

/** The Platform owns relay control auth. The VPS sends only its runtime token. */
export function createFundedAiRouteReadinessClient(
  config: FundedAiRuntimeConfig,
  fetchFn: typeof fetch = fetch,
): FundedAiRouteReadinessReader {
  return {
    async getRouteReadiness(options = {}) {
      const timeout = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetchFn(config.routeReadinessUrl, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${config.runtimeAuthToken}`, "content-type": "application/json", accept: "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Matrix AI route readiness unavailable");
      }
      return FundedAiRouteReadinessReceiptSchema.parse(await readBoundedFundedJson(response));
    },
  };
}
