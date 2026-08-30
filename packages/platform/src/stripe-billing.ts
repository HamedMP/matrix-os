import Stripe from 'stripe';
import { createHash, randomBytes } from 'node:crypto';
import type {
  StripeBillingClient,
  StripeAiCreditCheckoutSessionInput,
  StripeCheckoutSessionInput,
  StripeWebhookEvent,
} from './billing-routes.js';

export const MATRIX_STRIPE_API_VERSION = '2026-07-29.dahlia';
export const MATRIX_STRIPE_API_TIMEOUT_MS = 10_000;

function checkoutIntegrationIdentifier(prefix: 'matrix-subscription' | 'matrix-ai-credit'): string {
  const suffix = [...randomBytes(8)]
    .map((value) => String.fromCharCode(97 + (value % 26)))
    .join('');
  return `${prefix}-${suffix}`;
}

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
        integration_identifier: `matrix_checkout_${stableLetterSuffix(input.idempotencyKey)}`,
        ...(input.customerId ? { customer: input.customerId } : {}),
        client_reference_id: input.clerkUserId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: input.allowPromotionCodes,
        automatic_tax: { enabled: input.automaticTax },
        ...(input.expiresAt ? { expires_at: Math.floor(Date.parse(input.expiresAt) / 1_000) } : {}),
        ...(input.paymentMethodMode === 'card_required'
          ? { payment_method_collection: 'always' as const }
          : {}),
        metadata: {
          clerk_user_id: input.clerkUserId,
          matrix_region_slug: input.regionSlug,
          matrix_runtime_slot: input.runtimeSlot,
          ...(input.prebillingIntentId
            ? { matrix_prebilling_intent_id: input.prebillingIntentId }
            : {}),
        },
        subscription_data: {
          ...(input.trialPeriodDays
            ? {
              trial_period_days: input.trialPeriodDays,
              trial_settings: {
                end_behavior: { missing_payment_method: 'cancel' as const },
              },
            }
            : {}),
          metadata: {
            clerk_user_id: input.clerkUserId,
            matrix_region_slug: input.regionSlug,
            matrix_runtime_slot: input.runtimeSlot,
            ...(input.prebillingIntentId
              ? { matrix_prebilling_intent_id: input.prebillingIntentId }
              : {}),
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
      }, { idempotencyKey: input.idempotencyKey });
      if (!session.url) {
        throw new Error('Stripe checkout session missing redirect URL');
      }
      return {
        url: session.url,
        id: session.id,
        ...(session.expires_at
          ? { expiresAt: new Date(session.expires_at * 1_000).toISOString() }
          : {}),
      };
    },

    async createAiCreditCheckoutSession(input: StripeAiCreditCheckoutSessionInput) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        integration_identifier: checkoutIntegrationIdentifier('matrix-ai-credit'),
        client_reference_id: input.clerkUserId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        automatic_tax: { enabled: input.automaticTax },
        metadata: {
          matrix_checkout_kind: 'ai_credit_addon',
          matrix_owner_id: input.clerkUserId,
          matrix_machine_id: input.machineId,
          matrix_runtime_slot: input.runtimeSlot,
          matrix_ai_credit_package_id: input.packageId,
          matrix_ai_credit_request_id: input.requestId,
          matrix_ai_credit_price_id: input.priceId,
          matrix_ai_credit_microusd: String(input.amountMicrousd),
        },
      }, { idempotencyKey: input.idempotencyKey });
      if (!session.url) throw new Error('Stripe checkout session missing redirect URL');
      return { url: session.url, id: session.id };
    },

    async retrieveCheckoutSession(id) {
      const session = await stripe.checkout.sessions.retrieve(id, {
        expand: ['line_items.data.price'],
      });
      if (session.status !== 'open' && session.status !== 'complete' && session.status !== 'expired') {
        throw new Error('Stripe checkout session missing status');
      }
      const price = session.line_items?.data[0]?.price;
      return {
        status: session.status,
        url: session.url,
        clerkUserId: session.client_reference_id,
        priceId: typeof price === 'string' ? price : (price?.id ?? null),
        regionSlug: session.metadata?.matrix_region_slug ?? null,
      };
    },

    async createPortalSession(input) {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    constructWebhookEvent(rawBody, signature, webhookSecret): StripeWebhookEvent {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret) as StripeWebhookEvent;
    },
  };
}

function stableLetterSuffix(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 8);
  return Array.from(bytes, (value) => String.fromCharCode(97 + (value % 26))).join('');
}

export function createUnavailableStripeBillingClient(): StripeBillingClient {
  const unavailable = async () => {
    throw new Error('Stripe billing is not configured');
  };
  return {
    apiTimeoutMs: MATRIX_STRIPE_API_TIMEOUT_MS,
    createCheckoutSession: unavailable,
    createAiCreditCheckoutSession: unavailable,
    retrieveCheckoutSession: unavailable,
    createPortalSession: unavailable,
    constructWebhookEvent() {
      throw new Error('Stripe billing is not configured');
    },
  };
}
