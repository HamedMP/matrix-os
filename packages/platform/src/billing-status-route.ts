import type { Context, Handler } from 'hono';
import { z } from 'zod/v4';
import {
  MATRIX_HOSTED_BILLING_REGIONS,
  MatrixBillingStatusSchema,
  type MatrixBillingPublicEntitlement,
} from '@matrix-os/contracts';
import {
  getBillingCustomerByClerkUserId, getBillingEntitlementState, getBillingSubscription,
  getActiveCheckoutAttempt, isCardTrialOfferEligible, getActiveUserMachineByClerkId,
  type PlatformDB, type BillingSubscriptionRecord,
} from './db.js';
import {
  parseBillingEntitlementRecord, deriveStripeEntitlement, loadStripePriceCatalog,
  loadRuntimeCatalog, computeEffectiveEntitlement, parseBillingOverrideRecord,
  getRuntimeAccessDecision, projectPublicBillingEntitlement,
} from './billing.js';
import type { StripeBillingClient } from './billing-routes.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';

const BillingStatusQuerySchema = z.object({
  runtimeSlot: RuntimeSlotSchema.optional(),
  details: z.literal('management').optional(),
}).strict();
const BILLING_UNAVAILABLE_RESPONSE = { error: 'Billing unavailable', code: 'billing_unavailable' } as const;

export function createBillingStatusHandler(options: {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  cardTrialDays: number;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  resolvePublicRecurringPrice: (db: PlatformDB, stripe: StripeBillingClient, subscription: BillingSubscriptionRecord, now: Date) => Promise<MatrixBillingPublicEntitlement['recurringPrice']>;
  resolveRuntimePlacement: (location: string | null | undefined) => (typeof MATRIX_HOSTED_BILLING_REGIONS)[number] | null;
}): Handler {
  const { env, now, cardTrialDays } = options;
  return async (c) => {
    const clerkUserId = await options.resolveClerkUserId(c);
    if (!clerkUserId) return c.json({ error: 'Unauthorized' }, 401);
    try {
      const currentTime = now();
      const query = BillingStatusQuerySchema.safeParse(c.req.query());
      if (!query.success) return c.json({ error: 'Invalid request' }, 400);
      const runtimeSlot = query.data.runtimeSlot ?? 'primary';
      const customer = await getBillingCustomerByClerkUserId(options.db, clerkUserId);
      const state = await getBillingEntitlementState(options.db, clerkUserId, currentTime.toISOString());
      let stripeEntitlement = parseBillingEntitlementRecord(state.entitlement);
      const selectedSubscription = await getBillingSubscription(
        options.db,
        clerkUserId,
        runtimeSlot,
        currentTime.toISOString(),
      );
      if (query.data.runtimeSlot) {
        stripeEntitlement = selectedSubscription
          ? deriveStripeEntitlement({
            clerkUserId: selectedSubscription.clerkUserId,
            stripeCustomerId: selectedSubscription.stripeCustomerId,
            stripeSubscriptionId: selectedSubscription.stripeSubscriptionId,
            status: selectedSubscription.status,
            currentPeriodEnd: selectedSubscription.currentPeriodEnd,
            trialStartedAt: selectedSubscription.trialStartedAt,
            trialEndsAt: selectedSubscription.trialEndsAt,
            trialConvertedAt: selectedSubscription.trialConvertedAt,
            firstTrialPaymentFailedAt: selectedSubscription.firstTrialPaymentFailedAt,
            items: [{ priceId: selectedSubscription.stripePriceId, quantity: 1 }],
          }, {
            priceCatalog: loadStripePriceCatalog(env),
            runtimeCatalog: loadRuntimeCatalog(env),
            now: currentTime,
          })
          : null;
      }
      const entitlement = computeEffectiveEntitlement({
        stripeEntitlement,
        override: parseBillingOverrideRecord(state.override),
        now: currentTime,
      });
      const access = getRuntimeAccessDecision(entitlement, currentTime);
      const trialsEnabledForSlot = env.MATRIX_CARD_TRIALS_ENABLED === 'true'
        && runtimeSlot === 'primary';
      const activeAttempt = await getActiveCheckoutAttempt(options.db, clerkUserId, runtimeSlot);
      const offerEligible = trialsEnabledForSlot
        ? await isCardTrialOfferEligible(options.db, clerkUserId)
        : false;
      const reservedTrialDays = runtimeSlot === 'primary'
        ? activeAttempt?.trialPeriodDays ?? null
        : null;
      const trialOffer = {
        eligible: reservedTrialDays !== null || (offerEligible && !activeAttempt),
        durationDays: reservedTrialDays ?? cardTrialDays,
      };
      const recurringPrice = selectedSubscription
        && (query.data.details === 'management' || (entitlement?.source === 'stripe'
          && selectedSubscription.planSlug === entitlement.planSlug))
        ? await options.resolvePublicRecurringPrice(
          options.db,
          options.stripe,
          selectedSubscription,
          currentTime,
        )
        : null;
      const machine = await getActiveUserMachineByClerkId(
        options.db,
        clerkUserId,
        runtimeSlot,
      );
      const placement = options.resolveRuntimePlacement(machine?.location);
      // Only opted-in clients receive new fields: older installed clients parse a strict contract.
      const inventory = query.data.details === 'management'
        ? await options.db.executor.selectFrom('user_machines')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('clerk_user_id', '=', clerkUserId)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow()
        : null;
      const runtimePlacement = placement ? {
        regionSlug: placement.slug, label: placement.label,
        countryLabel: placement.countryLabel, networkZone: placement.networkZone,
      } : null;
      const response = MatrixBillingStatusSchema.safeParse({
        ...(inventory ? { management: {
          portalAvailable: customer !== undefined,
          runtimeSlot,
          computerCount: Number(inventory.count),
          runtimePlacement,
          subscription: selectedSubscription ? {
            planSlug: selectedSubscription.planSlug,
            status: selectedSubscription.status,
            billingInterval: selectedSubscription.billingInterval,
            recurringPrice,
            currentPeriodEnd: selectedSubscription.currentPeriodEnd,
            trialEndsAt: selectedSubscription.trialEndsAt,
            trialConvertedAt: selectedSubscription.trialConvertedAt,
            firstTrialPaymentFailedAt: selectedSubscription.firstTrialPaymentFailedAt,
          } : null,
        } } : {}),
        entitlement: entitlement
          ? projectPublicBillingEntitlement(entitlement, loadRuntimeCatalog(env), {
            portalAvailable: customer !== undefined,
            recurringPrice: entitlement.source === 'stripe' && selectedSubscription?.planSlug === entitlement.planSlug ? recurringPrice : null,
            runtimePlacement: placement ? {
              regionSlug: placement.slug,
              label: placement.label,
              countryLabel: placement.countryLabel,
              networkZone: placement.networkZone,
            } : null,
          })
          : null,
        access,
        trialOffer,
      });
      if (!response.success) {
        console.error('[billing] status response validation failed');
        return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      }
      return c.json(response.data, 200);
    } catch (err: unknown) {
      console.error('[billing] status lookup failed:', err instanceof Error ? err.message : String(err));
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }

  };
}
