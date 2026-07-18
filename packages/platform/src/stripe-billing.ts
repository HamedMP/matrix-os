import Stripe from 'stripe';
import type {
  StripeBillingClient,
  StripeCheckoutSessionInput,
  StripeWebhookEvent,
} from './billing-routes.js';

export const MATRIX_STRIPE_API_VERSION = '2026-04-22.dahlia';
export const MATRIX_STRIPE_API_TIMEOUT_MS = 10_000;

export function createStripeBillingClient(options: {
  secretKey: string;
  stripe?: Stripe;
}): StripeBillingClient {
  const stripe = options.stripe ?? new Stripe(options.secretKey, {
    apiVersion: MATRIX_STRIPE_API_VERSION,
    typescript: true,
    timeout: MATRIX_STRIPE_API_TIMEOUT_MS,
  });

  return {
    apiTimeoutMs: MATRIX_STRIPE_API_TIMEOUT_MS,

    async createCheckoutSession(input: StripeCheckoutSessionInput) {
      const session = await stripe.checkout.sessions.create({
        mode: input.mode,
        ...(input.customerId ? { customer: input.customerId } : {}),
        client_reference_id: input.clerkUserId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: input.allowPromotionCodes,
        automatic_tax: { enabled: input.automaticTax },
        metadata: {
          clerk_user_id: input.clerkUserId,
          matrix_region_slug: input.regionSlug,
        },
        subscription_data: {
          metadata: {
            clerk_user_id: input.clerkUserId,
            matrix_region_slug: input.regionSlug,
          },
        },
        tax_id_collection: { enabled: true },
        ...(input.customerId
          ? {
            customer_update: {
              address: 'auto' as const,
              name: 'auto' as const,
            },
          }
          : {}),
      });
      if (!session.url) {
        throw new Error('Stripe checkout session missing redirect URL');
      }
      return { url: session.url, id: session.id };
    },

    async createPortalSession(input) {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
        ...(input.flow
          ? {
            configuration: input.flow.configurationId,
            flow_data: {
              type: input.flow.type,
              subscription_update: { subscription: input.flow.subscriptionId },
              after_completion: {
                type: 'redirect',
                redirect: { return_url: input.flow.afterCompletionReturnUrl },
              },
            },
          }
          : {}),
      });
      return { url: session.url };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret): StripeWebhookEvent {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeWebhookEvent;
    },
  };
}

export function createUnavailableStripeBillingClient(): StripeBillingClient {
  const unavailable = async () => {
    throw new Error('Stripe billing is not configured');
  };
  return {
    apiTimeoutMs: MATRIX_STRIPE_API_TIMEOUT_MS,
    createCheckoutSession: unavailable,
    createPortalSession: unavailable,
    constructWebhookEvent() {
      throw new Error('Stripe billing is not configured');
    },
  };
}
