import { FUNDED_AI_READINESS_TIMEOUTS, JEV_MODEL_ID, FundedAiRouteReadinessReceiptSchema, FundedAiRuntimeFundingSummaryResponseSchema, FundedAiRuntimeChatFundingSummaryResponseSchema, type AiProviderReadiness } from "@matrix-os/contracts";
import type { FundedAiFundingSummaryReader } from "./funded-ai-funding-summary-client.js";
import type { FundedAiRouteReadinessReader } from "./funded-ai-route-readiness-client.js";
import { fundedAiFundingBarrier } from "./funded-ai-funding-state.js";

// Funding-summary stays bounded at 5s; route readiness also permits a cold relay.
// The outer bound leaves transport margin and covers dependencies ignoring abort.

export interface FundedAiReadiness {
  readiness: AiProviderReadiness;
  allowedModelIds: string[];
  /** Policy-authorized discovery only; never execution authority. */
  discoverableModelIds?: string[];
}
// Scheduled authority observes the control plane only. Unlike discovery, it
// need not run a model probe: only an actual governed turn uses the relay.
export const FUNDED_AI_SCHEDULE_AUTHORITY_TIMEOUT_MS = 6_000;
type ReadOptions = { signal?: AbortSignal; mode?: "schedule_authority" };
export interface FundedAiReadinessReader { read(options?: ReadOptions): Promise<FundedAiReadiness> }

export function createFundedAiReadinessReader(options: {
  summary: FundedAiFundingSummaryReader;
  routes?: FundedAiRouteReadinessReader;
  now?: () => Date;
  modelId?: typeof JEV_MODEL_ID;
}): FundedAiReadinessReader {
  const now = options.now ?? (() => new Date());
  const deadlineMs = options.modelId === JEV_MODEL_ID
    ? FUNDED_AI_READINESS_TIMEOUTS.jevObservationMs : FUNDED_AI_READINESS_TIMEOUTS.gatewayObservationMs;
  let inFlight: Promise<FundedAiReadiness> | undefined;

  async function readFresh(callerSignal?: AbortSignal, scheduleAuthority = false): Promise<FundedAiReadiness> {
    const checkedAt = now();
    const unavailable: FundedAiReadiness = {
      readiness: { state: "unavailable", checkedAt: checkedAt.toISOString(), staleAfter: null,
        action: "retry", safeReason: "provider_unavailable" },
      allowedModelIds: [],
      discoverableModelIds: [],
    };
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
        }, scheduleAuthority ? FUNDED_AI_SCHEDULE_AUTHORITY_TIMEOUT_MS : deadlineMs);
      });
      const summary = options.summary.getFundingSummary({ signal });
      const routes = !scheduleAuthority ? options.routes?.getRouteReadiness({ signal, ...(options.modelId ? { modelId: options.modelId } : {}) }).catch((error: unknown) => {
        console.warn("[funded-ai] Route observation unavailable:", error instanceof Error ? error.name : "UnknownError");
        return undefined;
      }) : undefined;
      const raw = await Promise.race([summary, deadline]);
      const { policy, funding } = FundedAiRuntimeFundingSummaryResponseSchema.parse({ contractVersion: 1, funding: raw.funding, policy: raw.policy });
      const chatAvailability = raw.chatAvailability === undefined ? undefined
        : FundedAiRuntimeChatFundingSummaryResponseSchema.parse({ contractVersion: 1, ...raw }).chatAvailability;
      const current = now().getTime();
      signal.throwIfAborted();
      const ledgerAsOf = Date.parse(funding.asOf);
      if (Date.parse(policy.checkedAt) > current || Date.parse(policy.staleAfter) <= current
        || ledgerAsOf > current + 60_000 || current - ledgerAsOf > 5 * 60_000) {
        if (scheduleAuthority) throw new Error("Stale schedule funding authority");
        return unavailable;
      }
      if (!policy.enabled) return unavailable;
      const discoverableModelIds = policy.allowedModelIds.map((id) => id.replace(/^anthropic\//, ""));
      const observationStaleAfter = new Date(Math.min(Date.parse(policy.staleAfter), ledgerAsOf + 5 * 60_000, checkedAt.getTime() + 30_000)).toISOString();
      const discovery = { ...unavailable, discoverableModelIds,
        readiness: { ...unavailable.readiness, staleAfter: observationStaleAfter } };
      if (!chatAvailability) {
        if (scheduleAuthority) throw new Error("Schedule Chat funding is unavailable");
        return discovery;
      }
      const barrier = fundedAiFundingBarrier(funding, chatAvailability);
      if (barrier) return { ...discovery, readiness: { ...discovery.readiness, ...barrier } };
      if (scheduleAuthority) {
        return discoverableModelIds.length > 0 ? {
          ...discovery, allowedModelIds: discoverableModelIds,
          readiness: { ...discovery.readiness, state: "ready", action: "none", safeReason: null },
        } : discovery;
      }
      let rawReceipt: unknown;
      try { rawReceipt = await Promise.race([Promise.resolve(routes), deadline]); }
      catch (error: unknown) {
        console.warn("[funded-ai] Route observation deadline:", error instanceof Error ? error.name : "UnknownError");
        return callerSignal?.aborted || Date.parse(observationStaleAfter) <= now().getTime() ? unavailable : discovery;
      }
      signal.throwIfAborted();
      const readyTime = now().getTime();
      if (Date.parse(observationStaleAfter) <= readyTime) return unavailable;
      const parsedReceipt = FundedAiRouteReadinessReceiptSchema.safeParse(rawReceipt);
      if (!parsedReceipt.success) return discovery;
      const receipt = parsedReceipt.data;
      if (receipt.globalRevision !== policy.globalRevision || receipt.runtimeRevision !== policy.runtimeRevision
        || Date.parse(receipt.checkedAt) > readyTime || Date.parse(receipt.staleAfter) <= readyTime
        || receipt.readyModelIds.some((id) => !policy.allowedModelIds.includes(id))) return discovery;
      const allowedModelIds = policy.allowedModelIds
        .filter((id) => receipt.readyModelIds.includes(id))
        .map((id) => id.replace(/^anthropic\//, ""));
      if (allowedModelIds.length === 0) return discovery;
      const staleAfter = new Date(Math.min(Date.parse(policy.staleAfter), Date.parse(receipt.staleAfter), checkedAt.getTime() + 30_000)).toISOString();
      return {
        readiness: { state: "ready", checkedAt: checkedAt.toISOString(),
          staleAfter,
          action: "none", safeReason: null },
        allowedModelIds,
        discoverableModelIds,
      };
    } catch (error) {
      console.warn("[funded-ai] Readiness check unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (scheduleAuthority) throw new Error("Schedule funding authority unavailable");
      return unavailable;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  return {
    read(call = {}) {
      // Only the private hosted scheduler can ask for current spending
      // authority without synthesizing a relay liveness observation.
      if (call.mode === "schedule_authority") return readFresh(call.signal, true);
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
