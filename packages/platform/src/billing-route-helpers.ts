/**
 * Billing route shared context, telemetry, auth, and contract types.
 *
 * Extracted from ./billing-routes.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { type Context } from 'hono';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { z } from 'zod/v4';
import { loadAiCreditCheckoutConfig } from './ai-credit-checkout.js';
import { getActiveCheckoutAttempt, upsertBillingEntitlement } from './db.js';
import type { AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import type { MarketingAttribution } from './billing-checkout-routes.js';
import type {
  MatrixBillingPublicEntitlement,
  MatrixHostedBillingRegionSlug,
} from '@matrix-os/contracts';
import { MATRIX_HOSTED_BILLING_REGIONS } from '@matrix-os/contracts';
import type {
  MatrixBillingInterval,
  MatrixBillingPlanSlug,
} from './billing.js';
import type { DeveloperToolId } from './developer-tools.js';
import type { RedditConversionsClient } from './reddit-conversions.js';
import type { PlatformDB } from './db.js';

export const BILLING_BODY_LIMIT = 16 * 1024;
export const STRIPE_WEBHOOK_BODY_LIMIT = 1024 * 1024;
export const MAX_STRIPE_API_TIMEOUT_MS = 10_000;
export const MATRIX_CARD_TRIAL_DAYS = 3;
export const MatrixCardTrialDaysSchema = z.string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(30));

export const BILLING_CHECKOUT_STARTED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_STARTED ?? 'matrix_billing_checkout_started';
export const BILLING_CHECKOUT_CREATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_CREATED ?? 'matrix_billing_checkout_created';
export const BILLING_CHECKOUT_FAILED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_FAILED ?? 'matrix_billing_checkout_failed';
export const BILLING_CHECKOUT_COMPLETED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_COMPLETED ?? 'matrix_billing_checkout_completed';
export const BILLING_CHECKOUT_EXPIRED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_EXPIRED ?? 'matrix_billing_checkout_expired';
export const BILLING_SUBSCRIPTION_UPDATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_SUBSCRIPTION_UPDATED ?? 'matrix_billing_subscription_updated';
export const BILLING_INVOICE_PAID_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAID ?? 'matrix_billing_invoice_paid';
export const BILLING_INVOICE_PAYMENT_FAILED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAYMENT_FAILED ?? 'matrix_billing_invoice_payment_failed';
export const BILLING_TRIAL_STARTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_STARTED;
export const BILLING_TRIAL_WILL_END_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_WILL_END;
export const BILLING_TRIAL_CONVERTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_CONVERTED;
export const BILLING_TRIAL_PAYMENT_FAILED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_PAYMENT_FAILED;
export const TRIAL_PAYMENT_SUSPEND_DELAY_MS = 24 * 60 * 60 * 1000;

export const HistoricalBillingRegionSlugSchema = z.enum([
  'region_fsn1',
  'region_nbg1',
  'region_ash',
  'region_hil',
]);


export const BILLING_UNAVAILABLE_RESPONSE = {
  error: 'Billing unavailable',
  code: 'billing_unavailable',
} as const;

export interface StripeCheckoutSessionInput {
  idempotencyKey: string;
  clerkUserId: string;
  customerId?: string;
  priceId: string;
  mode: 'subscription';
  automaticTax: boolean;
  allowPromotionCodes: boolean;
  regionSlug: string;
  runtimeSlot: string;
  redditAttributionExpiresAt: string;
  trialPeriodDays?: number | null;
  paymentMethodMode?: 'card_required' | 'dynamic';
  prebillingIntentId?: string;
  attribution?: MarketingAttribution;
  expiresAt?: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutSessionProjection {
  status: 'open' | 'complete' | 'expired';
  url: string | null;
  clerkUserId: string | null;
  priceId: string | null;
  regionSlug: string | null;
}

export interface StripeAiCreditCheckoutSessionInput {
  idempotencyKey: string;
  requestId: string;
  clerkUserId: string;
  machineId: string;
  runtimeSlot: string;
  packageId: string;
  priceId: string;
  amountMicrousd: number;
  automaticTax: boolean;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeRecurringPriceProjection {
  priceId: string;
  unitAmountMinor: number;
  currency: string;
  interval: MatrixBillingInterval;
  intervalCount: number;
}

export interface StripeBillingClient {
  apiTimeoutMs: number;
  /**
   * Implementations must use a bounded network timeout. Checkout creates the
   * Stripe Customer when needed; the signed subscription webhook links it back
   * to the Clerk user from server-written metadata.
   */
  createCheckoutSession(input: StripeCheckoutSessionInput): Promise<{
    url: string;
    id: string;
    expiresAt?: string;
  }>;
  clearSubscriptionAttribution?(subscriptionId: string): Promise<void>;
  createAiCreditCheckoutSession(input: StripeAiCreditCheckoutSessionInput): Promise<{
    url: string;
    id: string;
  }>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSessionProjection>;
  retrieveRecurringPrice(id: string): Promise<StripeRecurringPriceProjection>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  constructWebhookEvent(rawBody: string, signature: string, webhookSecret: string): StripeWebhookEvent;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { object: unknown };
}

export interface PrebillingCheckoutCoordinator {
  createIntent(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
    runtimeSlot: 'primary';
    planSlug: MatrixBillingPlanSlug;
    billingInterval: MatrixBillingInterval;
    serverType: string;
    regionSlug: string;
    developerTools: DeveloperToolId[];
    now: string;
  }): Promise<{ intentId: string; expiresAt: string } | undefined>;
  startPreparation(input: {
    intentId: string;
    stripeSessionId: string;
    stripeSessionExpiresAt: string;
  }): Promise<boolean>;
  getPreparationStatus(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
  }): Promise<'preparing' | 'ready' | 'failed'>;
  retryPreparation(input: {
    checkoutAttemptId: string;
    clerkUserId: string;
  }): Promise<boolean>;
  resumePreparation(input: {
    intentId: string;
    clerkUserId: string;
  }): Promise<boolean>;
  reconcilePreparations(): Promise<{ checked: number; resumed: number }>;
  authorizeSubscription(
    db: PlatformDB,
    input: { intentId: string; clerkUserId: string; runtimeSlot: string; now: string },
  ): Promise<{ authorized: boolean; machineId: string | null }>;
  expireCheckout(
    db: PlatformDB,
    input: { stripeSessionId: string; intentId?: string; clerkUserId?: string; now: string },
  ): Promise<{ cleaned: boolean; intentId: string | null }>;
}

function resolveCardTrialDays(env: NodeJS.ProcessEnv): number {
  const configured = env.MATRIX_CARD_TRIAL_DAYS;
  if (configured === undefined) return MATRIX_CARD_TRIAL_DAYS;
  const parsed = MatrixCardTrialDaysSchema.safeParse(configured);
  if (!parsed.success) {
    throw new Error('MATRIX_CARD_TRIAL_DAYS must be an integer from 1 to 30');
  }
  return parsed.data;
}

export interface BillingRouteOptions {
  db: PlatformDB;
  stripe: StripeBillingClient;
  env?: NodeJS.ProcessEnv;
  resolveClerkUserId: (c: Context) => Promise<string | null>;
  now?: () => Date;
  upsertEntitlement?: typeof upsertBillingEntitlement;
  prebilling?: PrebillingCheckoutCoordinator;
  fundedAiRepository?: Pick<import('./ai-funded-policy-repository.js').AiFundedPolicyRepository, 'grantCreditInTransaction'>;
  redditConversions?: RedditConversionsClient;
  /**
   * Optional product telemetry sink. Fire-and-forget: implementations must
   * never throw into the request path. Properties are PII-free product facts
   * such as plan, price amounts, runtime placement, and internal machine shape;
   * Stripe object IDs, provider server IDs, and IP addresses stay excluded.
   */
  captureEvent?: (
    event: string,
    options?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ) => void;
}

export interface BillingRouteContext {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  cardTrialDays: number;
  primaryPrebillingRequired: boolean;
  persistEntitlement: typeof upsertBillingEntitlement;
  aiCreditCheckout: ReturnType<typeof loadAiCreditCheckoutConfig>;
}

export function resolveBillingRouteContext(options: BillingRouteOptions): BillingRouteContext {
  const env = options.env ?? process.env;
  return {
    env,
    now: options.now ?? (() => new Date()),
    cardTrialDays: resolveCardTrialDays(env),
    primaryPrebillingRequired: env.CUSTOMER_VPS_ENABLED === 'true'
      && env.MATRIX_BILLING_PROVIDER === 'stripe',
    persistEntitlement: options.upsertEntitlement ?? upsertBillingEntitlement,
    aiCreditCheckout: loadAiCreditCheckoutConfig(env),
  };
}

export function createTelemetryEmitter(
  captureEvent: BillingRouteOptions['captureEvent'],
) {
  return function emitTelemetry(
    event: string,
    captureOptions?: { distinctId?: string; properties?: Record<string, string | number | boolean | undefined> },
  ): void {
    if (!captureEvent) return;
    try {
      captureEvent(event, captureOptions);
    } catch (err: unknown) {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[billing] telemetry capture failed for ${event}: ${kind}`);
    }
  };
}

export function createRouteAuth(
  resolveClerkUserId: BillingRouteOptions['resolveClerkUserId'],
) {
  return async function resolveRouteClerkUserId(c: Context, route: string): Promise<string | null> {
    try {
      return await resolveClerkUserId(c);
    } catch (err: unknown) {
      console.warn(`[billing] ${route} auth resolution failed:`, err instanceof Error ? err.name : typeof err);
      return null;
    }
  };
}

export function createPreparedCheckoutResponder(deps: {
  prebilling: BillingRouteOptions['prebilling'];
  primaryPrebillingRequired: boolean;
}) {
  return async function preparedCheckoutResponse(
    c: Context,
    clerkUserId: string,
    attempt: NonNullable<Awaited<ReturnType<typeof getActiveCheckoutAttempt>>>,
    retryFailed = false,
  ) {
    if (attempt.runtimeSlot !== 'primary') {
      if (!attempt.checkoutUrl) throw new Error('checkout_url_missing');
      return c.json({ url: attempt.checkoutUrl }, 200);
    }
    if (!deps.prebilling) {
      if (deps.primaryPrebillingRequired) return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
      if (!attempt.checkoutUrl) throw new Error('checkout_url_missing');
      return c.json({ url: attempt.checkoutUrl }, 200);
    }
    let status = await deps.prebilling.getPreparationStatus({
      checkoutAttemptId: attempt.id,
      clerkUserId,
    });
    if (status === 'failed' && retryFailed) {
      const restarted = await deps.prebilling.retryPreparation({
        checkoutAttemptId: attempt.id,
        clerkUserId,
      });
      if (restarted) {
        status = await deps.prebilling.getPreparationStatus({
          checkoutAttemptId: attempt.id,
          clerkUserId,
        });
      }
    }
    if (status === 'preparing') {
      return c.json({ status: 'preparing', attemptId: attempt.id }, 202);
    }
    if (status !== 'ready' || !attempt.checkoutUrl) {
      return c.json(BILLING_UNAVAILABLE_RESPONSE, 503);
    }
    return c.json({ url: attempt.checkoutUrl }, 200);
  };
}

export function resolveRuntimePlacement(
  machineLocation: string | null | undefined,
  fallbackRegionSlug: MatrixHostedBillingRegionSlug | null = null,
) {
  return MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.location === machineLocation)
    ?? MATRIX_HOSTED_BILLING_REGIONS.find((region) => region.slug === fallbackRegionSlug)
    ?? null;
}
