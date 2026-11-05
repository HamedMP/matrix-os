import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

const OBSERVATION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

/** Short retries are presentation recovery only; every turn still needs live admission. */
export function providerCatalogObservationRetryDelay(catalog: CanonicalProviderCatalog, attempt: number): number | null {
  return catalog.instances.some(instance => instance.observationState === "checking")
    ? OBSERVATION_RETRY_DELAYS_MS[attempt] ?? null : null;
}
