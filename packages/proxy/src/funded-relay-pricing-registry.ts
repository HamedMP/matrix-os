import { currentFundedAiPricingReview, type FundedAiPricingReview } from "@matrix-os/contracts";
import { FUNDED_PRICING_VERSIONS, type FundedPricingReview } from "./funded-pricing-review.js";
import { waitForRelayWork } from "./funded-relay-lifecycle.js";
import type { createFundedPlatformClient } from "./funded-relay-platform-client.js";

const CACHE_MS = 30_000;
const ROUTE_FAILURE_COOLDOWN_MS = 15_000;

export function createFundedPricingRegistry(options: Pick<ReturnType<typeof createFundedPlatformClient>,
  "readPricingReviews" | "reportPricingRouteFailure"> & {
  now: () => Date;
  shutdown: AbortSignal;
}) {
  let cached: { readAt: number; reviews: readonly FundedAiPricingReview[] } | undefined;
  let refreshing: Promise<boolean> | undefined;
  const lastRouteFailure = new Map<FundedPricingReview["canonicalModelId"], number>();

  function refresh() {
    const readAt = options.now().getTime();
    refreshing ??= options.readPricingReviews(options.shutdown).then(({ reviews }) => {
      cached = { readAt, reviews };
      return true;
    }, (error: unknown) => {
      cached = undefined;
      if (!options.shutdown.aborted) {
        console.warn("[proxy] Funded AI pricing registry read failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      return false;
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function fresh(at: Date) {
    const age = cached ? at.getTime() - cached.readAt : Infinity;
    return age >= 0 && age < CACHE_MS ? cached : undefined;
  }

  async function read(modelId: string, signal: AbortSignal, force = false): Promise<FundedPricingReview | null> {
    if (signal.aborted || options.shutdown.aborted) return null;
    if (force || refreshing || !fresh(options.now())) {
      if (!await waitForRelayWork(refresh(), signal)) return null;
    }
    const now = options.now();
    const review = fresh(now)?.reviews.find((entry) => entry.modelId === modelId);
    if (!review || !currentFundedAiPricingReview(review, now)
      || !Object.hasOwn(FUNDED_PRICING_VERSIONS, modelId)) return null;
    const canonicalModelId = modelId as FundedPricingReview["canonicalModelId"];
    if (review.version !== FUNDED_PRICING_VERSIONS[canonicalModelId]) return null;
    return {
      canonicalModelId,
      version: review.version,
      reviewedAt: review.reviewedAt,
      validThrough: review.blockedAt && review.blockedAt < review.validThrough ? review.blockedAt : review.validThrough,
    };
  }

  function reportFailure(modelId: string, version: string, status: number, signal: AbortSignal): void {
    if (status < 500 || status >= 600 || signal.aborted || options.shutdown.aborted
      || !Object.hasOwn(FUNDED_PRICING_VERSIONS, modelId)) return;
    const canonicalModelId = modelId as FundedPricingReview["canonicalModelId"];
    if (version !== FUNDED_PRICING_VERSIONS[canonicalModelId]) return;

    const time = performance.now();
    for (const [id, reportedAt] of lastRouteFailure) {
      if (time - reportedAt >= ROUTE_FAILURE_COOLDOWN_MS) lastRouteFailure.delete(id);
    }
    if (lastRouteFailure.has(canonicalModelId)) return;
    lastRouteFailure.set(canonicalModelId, time);

    void options.reportPricingRouteFailure({
      modelId, version, observedAt: options.now().toISOString(),
    }, options.shutdown).catch((error: unknown) => {
      if (!options.shutdown.aborted) {
        console.warn("[proxy] Funded AI pricing route failure report failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    });
  }

  return { read, reportFailure };
}
