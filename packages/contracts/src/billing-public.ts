import { z } from "zod/v4";
import {
  MATRIX_HOSTED_BILLING_PLAN_SLUGS,
  MATRIX_HOSTED_BILLING_REGION_SLUGS,
} from "#billing-catalog";
import { IsoTimestampSchema } from "#contract-primitives";

export const MatrixBillingPublicEntitlementSchema = z.object({
  source: z.enum(["stripe", "override"]),
  planSlug: z.union([
    z.enum(MATRIX_HOSTED_BILLING_PLAN_SLUGS),
    z.literal("internal"),
  ]),
  status: z.enum([
    "active",
    "trialing",
    "past_due",
    "canceled",
    "incomplete",
    "unpaid",
    "ended",
    "none",
  ]),
  maxRuntimeSlots: z.number().int().nonnegative(),
  includedRuntimeSlots: z.number().int().nonnegative(),
  addonRuntimeSlots: z.number().int().nonnegative(),
  allowedPlanSlugs: z.array(z.enum(MATRIX_HOSTED_BILLING_PLAN_SLUGS)).max(
    MATRIX_HOSTED_BILLING_PLAN_SLUGS.length,
  ),
  allowedSelections: z.array(z.strictObject({
    planSlug: z.enum(MATRIX_HOSTED_BILLING_PLAN_SLUGS),
    regionSlug: z.enum(MATRIX_HOSTED_BILLING_REGION_SLUGS),
  })).max(
    MATRIX_HOSTED_BILLING_PLAN_SLUGS.length * MATRIX_HOSTED_BILLING_REGION_SLUGS.length,
  ).default([]),
  portalAvailable: z.boolean(),
  billingInterval: z.enum(["monthly", "annual"]).nullable(),
  recurringPrice: z.strictObject({
    unitAmountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[a-z]{3}$/),
    interval: z.enum(["monthly", "annual"]),
    intervalCount: z.number().int().positive(),
    quantity: z.number().int().positive(),
  }).nullable().default(null),
  runtimePlacement: z.strictObject({
    regionSlug: z.enum(MATRIX_HOSTED_BILLING_REGION_SLUGS),
    label: z.string().min(1).max(128),
    countryLabel: z.string().min(1).max(64),
    networkZone: z.enum(["eu-central", "us-east", "us-west"]),
  }).nullable().default(null),
  gracePeriodEndsAt: IsoTimestampSchema.nullable(),
  trialStartedAt: IsoTimestampSchema.nullable(),
  trialEndsAt: IsoTimestampSchema.nullable(),
  trialConvertedAt: IsoTimestampSchema.nullable(),
  firstTrialPaymentFailedAt: IsoTimestampSchema.nullable(),
  effectiveFrom: IsoTimestampSchema,
  effectiveUntil: IsoTimestampSchema.nullable(),
  updatedAt: IsoTimestampSchema,
}).strict();

export const MatrixBillingStatusSchema = z.object({
  entitlement: MatrixBillingPublicEntitlementSchema.nullable(),
  access: z.object({
    runtimeProxyAllowed: z.boolean(),
    reason: z.enum(["active", "grace_period", "payment_required", "no_entitlement"]),
    gracePeriodEndsAt: IsoTimestampSchema.nullable().optional(),
  }).strict(),
  trialOffer: z.object({
    eligible: z.boolean(),
    durationDays: z.number().int().min(1).max(30),
  }).strict(),
}).strict();

export type MatrixBillingPublicEntitlement = z.infer<typeof MatrixBillingPublicEntitlementSchema>;
export type MatrixBillingStatus = z.infer<typeof MatrixBillingStatusSchema>;

/**
 * Maximum accepted length of a billing redirect target.
 *
 * Stripe-hosted portal and checkout URLs are far shorter than this; the bound
 * exists so a regressed or hostile upstream response cannot hand a client an
 * unbounded string to navigate to.
 */
export const MATRIX_BILLING_REDIRECT_MAX_LENGTH = 2048;

/**
 * Shared contract for billing portal and checkout redirect responses.
 *
 * Every client (Web, Electron Desktop, Native Mobile) must validate through
 * this schema before navigating or opening a browser. The platform normally
 * returns a trusted Stripe HTTPS URL, so this is defense in depth: a relative,
 * HTTP, or executable-scheme URL must never reach a navigation call.
 */
/**
 * Parse a redirect candidate, returning `null` instead of throwing.
 *
 * Any parse failure is a rejection rather than a rethrow: a relative path or
 * malformed value simply is not a navigable target, React Native's URL polyfill
 * does not reliably throw `TypeError`, and `parseBillingRedirectUrl` is
 * documented never to throw. The failure is deliberately neither logged nor
 * surfaced, because it can embed the untrusted redirect value and every caller
 * already reports a generic error.
 *
 * (`URL.parse` would express this directly, but it is unavailable on the ES2022
 * target and on Hermes, and this module ships to Native Mobile.)
 */
function parseAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch (err: unknown) {
    // Every URL implementation in play (V8, JSC, Hermes and its polyfill)
    // reports a bad URL as an `Error`. Anything else is not a parse failure
    // this function can interpret, so it propagates rather than being silently
    // reported as "not a valid URL".
    if (err instanceof Error) return null;
    throw err;
  }
}

export const MatrixBillingRedirectSchema = z.strictObject({
  url: z
    .string()
    .max(MATRIX_BILLING_REDIRECT_MAX_LENGTH)
    .refine((value) => {
      const parsed = parseAbsoluteUrl(value);
      if (parsed === null) return false;
      // Reject embedded credentials: `https://evil.example@billing.stripe.com`
      // parses as https but renders an attacker-controlled authority.
      if (parsed.username !== "" || parsed.password !== "") return false;
      return parsed.protocol === "https:";
    }, "Billing redirects must be absolute HTTPS URLs"),
});

export type MatrixBillingRedirect = z.infer<typeof MatrixBillingRedirectSchema>;

/**
 * Parse an untrusted billing redirect response body.
 *
 * Returns the safe HTTPS URL, or `null` for any response that is missing,
 * malformed, or unsafe to navigate to. Callers should surface a generic,
 * retryable error on `null` and must not echo the upstream response.
 */
export function parseBillingRedirectUrl(body: unknown): string | null {
  const result = MatrixBillingRedirectSchema.safeParse(body);
  return result.success ? result.data.url : null;
}
