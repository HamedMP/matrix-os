import type { AiProviderReadiness } from "@matrix-os/contracts";
import type { FundedAiReadiness } from "../funded-ai-readiness.js";

/** A shared source is ready only for the exact models with fresh relay receipts. */
export function fundedSourceObservation(
  modelIds: readonly string[],
  readiness: AiProviderReadiness,
  funded: FundedAiReadiness | undefined,
): { readiness: AiProviderReadiness; eligibleModelIds: string[]; discoverableModelIds: string[] } {
  const readyModelIds = modelIds.filter(id => funded?.allowedModelIds.includes(id));
  const discoverableModelIds = modelIds.filter(id =>
    (funded?.discoverableModelIds ?? funded?.allowedModelIds)?.includes(id));
  const ready = readiness.state === "ready" && readyModelIds.length > 0;
  const observed = ready || discoverableModelIds.length > 0;
  return {
    readiness: funded !== undefined && (!observed || (readiness.state === "ready" && !ready))
      ? { state: "unavailable", checkedAt: readiness.checkedAt, staleAfter: observed ? readiness.staleAfter : null,
        action: "retry", safeReason: "provider_unavailable" }
      : readiness,
    // Discovery remains available when the entire source is unavailable. A
    // partially healthy source must not make failed sibling models runnable.
    eligibleModelIds: ready ? readyModelIds : discoverableModelIds,
    discoverableModelIds,
  };
}
