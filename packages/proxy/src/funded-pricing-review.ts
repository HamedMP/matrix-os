/** Numeric rates are immutable code snapshots; operator configuration only
 * re-attests their validity after checking the official provider price pages. */
export const FUNDED_PRICING_VERSIONS = Object.freeze({
  "anthropic/claude-sonnet-5": "anthropic-2026-08-31-standard",
  "@cf/zai-org/glm-5.3-flash": "cloudflare-2026-09-10-glm-flash",
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
  const models = [["SONNET", "anthropic/claude-sonnet-5"], ["GLM", "@cf/zai-org/glm-5.3-flash"]] as const;
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
  return Object.freeze(reviews);
}
