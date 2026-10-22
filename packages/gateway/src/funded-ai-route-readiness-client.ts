import { createHash } from "node:crypto";
import { IsolatedChatEnvelopeSchema, FUNDED_AI_READINESS_TIMEOUTS, FundedAiRouteReadinessReceiptSchema, FundedAiRouteReadinessRequestSchema, JEV_MODEL_ID, type FundedAiRouteReadinessReceipt } from "@matrix-os/contracts";
import type { FundedAiRuntimeConfig } from "./funded-ai-credential-manager.js";
import { createCanonicalPhaseReadiness, type CanonicalPhaseReadinessOptions } from "./chat/canonical-phase-readiness.js";
import { readBoundedFundedJson } from "./funded-ai-funding-summary-client.js";

export interface FundedAiRouteReadinessReader {
  getRouteReadiness(options?: { signal?: AbortSignal; modelId?: typeof JEV_MODEL_ID }): Promise<FundedAiRouteReadinessReceipt>;
}

/** The Platform owns relay control auth. The VPS sends only its runtime token. */
export function createFundedAiRouteReadinessClient(
  config: FundedAiRuntimeConfig,
  fetchFn: typeof fetch = fetch,
  options: CanonicalPhaseReadinessOptions = {},
): FundedAiRouteReadinessReader {
  const phase = config.isolatedChat ? IsolatedChatEnvelopeSchema.parse(config.isolatedChat) : undefined;
  const scoped = createCanonicalPhaseReadiness(phase, options);
  const target = phase !== undefined && phase.ownerId === config.identity.ownerId
    && phase.machineId === config.identity.machineId && phase.runtimeSlot === config.identity.runtimeSlot;
  return {
    async getRouteReadiness(options = {}) {
      scoped.observationScope();
      if (scoped.canonical && (!target || options.modelId !== undefined)) throw new Error("Matrix AI route readiness unavailable");
      // Generic readiness also waits for a cold relay. Do not extend credential
      // issuance/funding-summary timeouts. Jev has its own bounded settlement window.
      const timeout = AbortSignal.timeout(options.modelId === JEV_MODEL_ID
        ? FUNDED_AI_READINESS_TIMEOUTS.jevGatewayRequestMs : FUNDED_AI_READINESS_TIMEOUTS.gatewayRequestMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const bound = target && options.modelId !== JEV_MODEL_ID;
      if (bound && createHash("sha256").update(config.runtimeAuthToken).digest("hex") !== phase!.runtimeCredentialSha256) {
        throw new Error("Matrix AI route readiness unavailable");
      }
      const response = await fetchFn(config.routeReadinessUrl, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${config.runtimeAuthToken}`, "content-type": "application/json", accept: "application/json",
          ...(bound ? { "x-matrix-isolated-chat-phase": phase!.phaseId,
            ...(scoped.canonical ? { "x-matrix-isolated-chat-config": scoped.digest! } : {}) } : {}) },
        body: JSON.stringify(FundedAiRouteReadinessRequestSchema.parse({ modelId: options.modelId })),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Matrix AI route readiness unavailable");
      }
      return FundedAiRouteReadinessReceiptSchema.parse(await readBoundedFundedJson(response));
    },
  };
}
