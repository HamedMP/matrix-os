import type { MatrixBillingInterval, MatrixBillingPlanSlug } from '../billing.js';
import type { DeveloperToolId } from '../developer-tools.js';
import type { MatrixHostedBillingRegionSlug } from '@matrix-os/contracts';
import type { MarketingAttribution } from './checkout-schemas.js';

/** Extracted verbatim from packages/platform/src/billing-routes.ts (S01 / T007): Stripe client and webhook event contracts. */

export const MAX_STRIPE_API_TIMEOUT_MS = 10_000;

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
