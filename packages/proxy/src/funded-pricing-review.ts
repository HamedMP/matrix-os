import { WORKERS_AI_PRICE_SNAPSHOTS, WORKERS_AI_PRICING_VERSIONS } from "./funded-workers-pricing.js";
/** Numeric rates are immutable code snapshots; operator configuration only
 * re-attests their validity after checking the official provider price pages. */
export const FUNDED_PRICING_VERSIONS = Object.freeze({
  "anthropic/claude-sonnet-5": "anthropic-2026-08-31-standard",
  ...WORKERS_AI_PRICING_VERSIONS,
});
export interface FundedPricingReview {
  canonicalModelId: keyof typeof FUNDED_PRICING_VERSIONS;
  version: string;
  reviewedAt: string;
  validThrough: string;
}
export type FundedPricingReviews = readonly Readonly<FundedPricingReview>[];
const MAX_REVIEW_WINDOW_MS = 31 * 24 * 60 * 60_000;
function canonicalTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("Invalid funded AI pricing review timestamp");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Invalid funded AI pricing review timestamp");
  }
  return time;
}
export function validateFundedPricingReview(review: FundedPricingReview): void {
  if (!Object.hasOwn(FUNDED_PRICING_VERSIONS, review.canonicalModelId)
    || review.version !== FUNDED_PRICING_VERSIONS[review.canonicalModelId]) {
    throw new Error("Invalid funded AI pricing review version");
  }
  const duration = canonicalTime(review.validThrough) - canonicalTime(review.reviewedAt);
  if (duration <= 0 || duration > MAX_REVIEW_WINDOW_MS) {
    throw new Error("Invalid funded AI pricing review window");
  }
}
export function readFundedPricingReviews(env: NodeJS.ProcessEnv): FundedPricingReviews {
  const models: readonly (readonly [string, keyof typeof FUNDED_PRICING_VERSIONS])[] = [
    ["SONNET", "anthropic/claude-sonnet-5"],
    ...Object.entries(WORKERS_AI_PRICE_SNAPSHOTS).map(([id, price]) =>
      [price.prefix, id as keyof typeof WORKERS_AI_PRICE_SNAPSHOTS] as const),
  ];
  const reviews: Readonly<FundedPricingReview>[] = [];
  for (const [prefix, canonicalModelId] of models) {
    const version = env[`MATRIX_FUNDED_${prefix}_PRICING_REVIEW_VERSION`];
    const reviewedAt = env[`MATRIX_FUNDED_${prefix}_PRICING_REVIEWED_AT`];
    const validThrough = env[`MATRIX_FUNDED_${prefix}_PRICING_VALID_THROUGH`];
    // Keep the historical expired snapshot when no operator review is supplied.
    // Never create a rolling process-start validity window.
    if (version === undefined && reviewedAt === undefined && validThrough === undefined) continue;
    if (version === undefined || reviewedAt === undefined || validThrough === undefined) {
      throw new Error("Incomplete funded AI pricing review");
    }
    const review = { canonicalModelId, version, reviewedAt, validThrough };
    validateFundedPricingReview(review);
    reviews.push(Object.freeze(review));
  }
  const bundleVersion = env.MATRIX_FUNDED_WORKERS_PRICING_REVIEW_VERSION || undefined;
  const bundleReviewedAt = env.MATRIX_FUNDED_WORKERS_PRICING_REVIEWED_AT || undefined;
  const bundleValidThrough = env.MATRIX_FUNDED_WORKERS_PRICING_VALID_THROUGH || undefined;
  if (bundleVersion !== undefined || bundleReviewedAt !== undefined || bundleValidThrough !== undefined) {
    if (bundleVersion !== "cloudflare-2026-10-15-workers-eight" || !bundleReviewedAt || !bundleValidThrough) {
      throw new Error("Invalid bundled Workers AI pricing review");
    }
    for (const [id, price] of Object.entries(WORKERS_AI_PRICE_SNAPSHOTS)) {
      if (price.prefix === "GLM") continue; // Existing Flash review stays independent.
      const canonicalModelId = id as keyof typeof WORKERS_AI_PRICE_SNAPSHOTS;
      if (reviews.some(review => review.canonicalModelId === canonicalModelId)) {
        throw new Error("Duplicate funded AI pricing review");
      }
      const review = { canonicalModelId, version: price.version,
        reviewedAt: bundleReviewedAt, validThrough: bundleValidThrough };
      validateFundedPricingReview(review);
      reviews.push(Object.freeze(review));
    }
  }
  return Object.freeze(reviews);
}
