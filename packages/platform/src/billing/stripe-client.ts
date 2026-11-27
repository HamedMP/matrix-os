import type { MatrixBillingInterval, MatrixBillingPlanSlug } from '../billing.js';
import type { DeveloperToolId } from '../developer-tools.js';
import type { MatrixHostedBillingRegionSlug } from '@matrix-os/contracts';
import type { GoogleAnalyticsAttribution } from './checkout-schemas.js';
import type { MarketingAttribution } from './checkout-schemas.js';

/** Extracted verbatim from packages/platform/src/billing-routes.ts (S01 / T007): Stripe client and webhook event contracts. */

export const MAX_STRIPE_API_TIMEOUT_MS = 10_000;

export type FreeOwnerCheckoutRefundStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';

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
  googleAnalytics?: GoogleAnalyticsAttribution;
  planSlug?: MatrixBillingPlanSlug;
  interval?: MatrixBillingInterval;
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
  expireCheckoutSession?(id: string): Promise<StripeCheckoutSessionProjection>;
  /**
   * ENG-520 launch guard compensation for one blocked Checkout session: cancel
   * its subscription (no proration, no final invoice), then settle only that
   * session's own invoice: void it while open, or refund its payment once paid.
   * With `refundId` the existing refund is polled instead of creating one;
   * `refundRound` > 0 starts a new refund after a failed one. `settled` is
   * false while the invoice could still be paid.
   */
  compensateFreeOwnerCheckout?(input: { sessionId: string; refundId: string | null; refundRound: number }): Promise<{
    subscriptionId: string | null;
    settled: boolean;
    refund: { id: string; status: FreeOwnerCheckoutRefundStatus } | null;
  }>;
  retrieveTrackingCheckout?(id: string): Promise<unknown>;
  retrieveTrackingInvoice?(id: string): Promise<unknown>;
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
