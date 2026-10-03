import { JEV_PRICING_VERSION } from "@matrix-os/contracts";

export interface JevPricingReview {
  version: typeof JEV_PRICING_VERSION;
  reviewedAt: string;
  validThrough: string;
}
const MAX_REVIEW_WINDOW_MS = 90 * 24 * 60 * 60_000;
/** Compatibility snapshot only: never renew this at process startup. */
export const LEGACY_JEV_PRICING_REVIEW: Readonly<JevPricingReview> = Object.freeze({
  version: JEV_PRICING_VERSION,
  reviewedAt: "2026-09-01T00:00:00.000Z",
  validThrough: "2026-09-30T23:59:59.999Z",
});
function canonicalTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("Invalid Jev pricing review");
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error("Invalid Jev pricing review");
  return time;
}
/** This attests validity of one immutable rate; configuration cannot change pricing. */
export function validateJevPricingReview(review: JevPricingReview): void {
  if (review.version !== JEV_PRICING_VERSION) throw new Error("Invalid Jev pricing review version");
  const duration = canonicalTime(review.validThrough) - canonicalTime(review.reviewedAt);
  if (duration <= 0 || duration > MAX_REVIEW_WINDOW_MS) throw new Error("Invalid Jev pricing review window");
}
export function readJevPricingReview(env: NodeJS.ProcessEnv): Readonly<JevPricingReview> {
  const version = env.MATRIX_JEV_PRICING_REVIEW_VERSION;
  const reviewedAt = env.MATRIX_JEV_PRICING_REVIEWED_AT;
  const validThrough = env.MATRIX_JEV_PRICING_VALID_THROUGH;
  if (version === undefined && reviewedAt === undefined && validThrough === undefined) return LEGACY_JEV_PRICING_REVIEW;
  // Do not trim/normalize an attestation: malformed or partial deployment input fails closed.
  const review = { version, reviewedAt, validThrough } as JevPricingReview;
  validateJevPricingReview(review);
  return Object.freeze(review);
}
export function assertJevPricingReviewCurrent(at: Date, review: JevPricingReview): void {
  validateJevPricingReview(review);
  const time = at.getTime();
  if (!Number.isFinite(time) || time < Date.parse(review.reviewedAt) || time > Date.parse(review.validThrough)) {
    throw new Error("Jev pricing has expired or its review is not current");
  }
}
