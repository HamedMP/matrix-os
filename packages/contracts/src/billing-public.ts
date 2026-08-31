import { z } from "zod/v4";
import { MATRIX_HOSTED_BILLING_PLAN_SLUGS } from "#billing-catalog";
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
  portalAvailable: z.boolean(),
  billingInterval: z.enum(["monthly", "annual"]).nullable(),
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
