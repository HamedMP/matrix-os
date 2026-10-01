import { expect, it } from "vitest";
import { JEV_PRICING_VERSION } from "@matrix-os/contracts";
import { readJevPricingReview } from "../../packages/proxy/src/jev-pricing-review.js";
import { reviewedJevPricing } from "../../packages/proxy/src/funded-relay-evaluation.js";
const env = {
  MATRIX_JEV_PRICING_REVIEW_VERSION: JEV_PRICING_VERSION,
  MATRIX_JEV_PRICING_REVIEWED_AT: "2026-10-01T00:00:00.000Z",
  MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-31T23:59:59.999Z",
};
it("renews the same immutable rate using explicit bounded operator review", () => {
  const review = readJevPricingReview(env);
  const pricing = reviewedJevPricing(new Date("2026-10-01T01:00:00.000Z"), review);
  expect(pricing).toMatchObject({ version: JEV_PRICING_VERSION, nanoUsdPerInputToken: 42n,
    validThrough: env.MATRIX_JEV_PRICING_VALID_THROUGH });
});
it("does not auto-extend the expired legacy review when configuration is absent", () => {
  expect(() => reviewedJevPricing(new Date("2026-10-01T00:00:00.000Z"), readJevPricingReview({}))).toThrow();
});
it.each([
  { MATRIX_JEV_PRICING_REVIEW_VERSION: "other-price" },
  { MATRIX_JEV_PRICING_REVIEWED_AT: "2026-10-01" },
  { MATRIX_JEV_PRICING_REVIEWED_AT: "2026-02-30T00:00:00.000Z" },
  { MATRIX_JEV_PRICING_REVIEWED_AT: "2026-10-01T00:00:00+00:00" },
  { MATRIX_JEV_PRICING_VALID_THROUGH: "2026-10-01T00:00:00.000Z" },
  { MATRIX_JEV_PRICING_VALID_THROUGH: "2027-10-01T00:00:00.000Z" },
  { MATRIX_JEV_PRICING_VALID_THROUGH: undefined },
])("rejects malformed, partial or incompatible review %j", overrides => {
  expect(() => readJevPricingReview({ ...env, ...overrides })).toThrow();
});
it.each(["2026-09-30T23:59:59.999Z", "2026-11-01T00:00:00.000Z"])("fails closed outside reviewed window at %s", at => {
  expect(() => reviewedJevPricing(new Date(at), readJevPricingReview(env))).toThrow();
});
