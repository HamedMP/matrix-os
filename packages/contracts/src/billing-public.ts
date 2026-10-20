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

export const MatrixBillingActiveCheckoutSchema = z.strictObject({
  status: z.enum(["creating", "open"]),
  planSlug: z.enum(MATRIX_HOSTED_BILLING_PLAN_SLUGS),
  interval: z.enum(["monthly", "annual"]),
  regionSlug: z.enum(MATRIX_HOSTED_BILLING_REGION_SLUGS),
  developerTools: z.array(z.enum(["codex", "claude-code", "opencode", "pi"]))
    .max(4)
    .refine((tools) => new Set(tools).size === tools.length, "Duplicate developer tools"),
});

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
  activeCheckout: MatrixBillingActiveCheckoutSchema.nullable().default(null),
}).strict();

export type MatrixBillingPublicEntitlement = z.infer<typeof MatrixBillingPublicEntitlementSchema>;
export type MatrixBillingStatus = z.infer<typeof MatrixBillingStatusSchema>;
export type MatrixBillingActiveCheckout = z.infer<typeof MatrixBillingActiveCheckoutSchema>;
