import { z } from 'zod/v4';
import { DEFAULT_BILLING_PLAN_DEFINITIONS, type MatrixBillingInterval, type MatrixBillingPlanSlug } from '../billing.js';

const id = z.string().regex(/^[a-z]+_[A-Za-z0-9_]{1,252}$/);
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[a-z]{3}$/);
const expandedId = z.union([id, z.object({ id })]);
const presentment = z.object({ presentment_amount: minor, presentment_currency: currency }).nullish();
const selection = z.object({ matrix_plan_slug: z.enum(['matrix_starter', 'matrix_builder', 'matrix_max']),
  matrix_billing_interval: z.enum(['monthly', 'annual']), matrix_trial_days: z.string().regex(/^\d{1,2}$/),
  matrix_google_client_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  matrix_google_analytics_consent: z.literal('granted'),
  matrix_google_expires_at: z.string().regex(/^[0-9]{13}$/),
  matrix_google_ad_user_data: z.enum(['granted', 'denied']).default('denied'),
  matrix_google_ad_personalization: z.enum(['granted', 'denied']).default('denied'),
});

export interface BillingTrackingEvent {
  event: 'purchase' | 'trial_started';
  event_id: string;
  plan: MatrixBillingPlanSlug;
  billing_interval: MatrixBillingInterval;
  amount_paid: number;
  trial_converted?: boolean;
  ecommerce: { transaction_id: string; currency: string; value: number; tax: number;
    items: Array<{ item_id: string; item_name: string; item_variant: string; price: number; quantity: number }> };
}
export interface InvoiceTrackingPurchase {
  subscriptionId: string;
  clientId: string;
  eventAt?: number;
  consentExpiresAt?: number;
  needsInvoiceLookup?: boolean;
  adUserData: 'granted' | 'denied';
  adPersonalization: 'granted' | 'denied';
  event: BillingTrackingEvent;
}

export function withCheckoutSessionId(value: string): string {
  const url = new URL(value);
  url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  // Stripe substitutes the literal token; URLSearchParams otherwise encodes it.
  return url.toString().replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
}

export function stripeAmount(amount: number, code: string): number {
  // Stripe charges ISK and UGX in hundredths despite their ISO zero-digit format.
  const digits = ['isk', 'ugx'].includes(code) ? 2
    : new Intl.NumberFormat('en', { style: 'currency', currency: code.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  return amount / 10 ** digits;
}

function buildEvent(input: { transactionId: string; amount: number; tax: number; currency: string;
  presentment?: { presentment_amount: number; presentment_currency: string } | null;
  planSlug: MatrixBillingPlanSlug; interval: MatrixBillingInterval; trial?: boolean }): BillingTrackingEvent {
  const paidMinor = input.presentment?.presentment_amount ?? input.amount;
  const code = input.presentment?.presentment_currency ?? input.currency;
  // Adaptive Pricing exposes the customer total, not a localized tax breakdown.
  // Allocate that total proportionally, rounding once to customer minor units.
  const taxMinor = input.amount > 0 ? Math.round(paidMinor * input.tax / input.amount) : 0;
  const net = stripeAmount(paidMinor - taxMinor, code);
  const transactionId = input.transactionId;
  return { event: input.trial ? 'trial_started' : 'purchase', event_id: `${input.trial ? 'trial' : 'purchase'}_${transactionId}`,
    plan: input.planSlug, billing_interval: input.interval, amount_paid: stripeAmount(paidMinor, code),
    ecommerce: { transaction_id: transactionId, currency: code.toUpperCase(), value: net, tax: stripeAmount(taxMinor, code),
      items: [{ item_id: input.planSlug,
        item_name: DEFAULT_BILLING_PLAN_DEFINITIONS.find(plan => plan.slug === input.planSlug)!.marketingName,
        item_variant: input.interval, price: net, quantity: 1 }] } };
}

const CheckoutSchema = z.object({ id, livemode: z.literal(true), mode: z.literal('subscription'), status: z.literal('complete'),
  payment_status: z.enum(['paid', 'no_payment_required']), amount_total: minor, currency,
  invoice: expandedId.nullish(), subscription: z.object({ id, status: z.string(), trial_end: z.number().nullish() }),
  total_details: z.object({ amount_tax: minor, amount_shipping: minor.optional() }), presentment_details: presentment,
});
export function checkoutTrackingEvent(value: unknown, plan: { planSlug: MatrixBillingPlanSlug; interval: MatrixBillingInterval }): BillingTrackingEvent | null {
  const parsed = CheckoutSchema.safeParse(value);
  if (!parsed.success) return null;
  const session = parsed.data;
  if (session.total_details.amount_tax > session.amount_total || session.total_details.amount_shipping) return null;
  const trial = session.amount_total === 0 && session.subscription.status === 'trialing' && Boolean(session.subscription.trial_end);
  if (!trial && (session.payment_status !== 'paid' || session.amount_total <= 0 || !session.invoice)) return null;
  if (session.presentment_details && session.amount_total > 0 && session.presentment_details.presentment_amount <= 0) return null;
  const transactionId = trial ? session.subscription.id
    : typeof session.invoice === 'string' ? session.invoice : session.invoice!.id;
  return buildEvent({ transactionId, amount: session.amount_total, tax: session.total_details.amount_tax,
    currency: session.currency, presentment: session.presentment_details, ...plan, trial });
}

const InvoiceIdentitySchema = z.object({ id, livemode: z.literal(true), status: z.literal('paid'), billing_reason: z.enum(['subscription_create', 'subscription_cycle']),
  amount_paid: minor.positive(), total: minor.positive(), currency,
  parent: z.object({ subscription_details: z.object({ subscription: expandedId, metadata: selection }) }),
});
export interface InvoiceAcquisitionIdentity { subscriptionId: string; transactionId: string }
/** Remember the first positive payment even when its allocation cannot be measured. */
export function invoiceAcquisitionIdentity(value: unknown): InvoiceAcquisitionIdentity | null {
  const parsed = InvoiceIdentitySchema.safeParse(value);
  if (!parsed.success || Number(parsed.data.parent.subscription_details.metadata.matrix_google_expires_at) <= Date.now()) return null;
  const subscription = parsed.data.parent.subscription_details.subscription;
  return { subscriptionId: typeof subscription === 'string' ? subscription : subscription.id, transactionId: parsed.data.id };
}
const InvoiceSchema = InvoiceIdentitySchema.extend({
  total_taxes: z.array(z.object({ amount: minor })).nullish(),
  payments: z.object({ data: z.array(z.object({ status: z.string(), payment: z.object({ payment_intent: z.union([z.string(), z.object({
    amount_received: minor, currency, presentment_details: presentment,
  })]).nullish() }) })) }).optional(),
});
export function invoiceTrackingEvent(value: unknown): InvoiceTrackingPurchase | null {
  const parsed = InvoiceSchema.safeParse(value);
  if (!parsed.success) return null;
  const invoice = parsed.data;
  const metadata = invoice.parent.subscription_details.metadata;
  if (Number(metadata.matrix_google_expires_at) <= Date.now()) return null;
  const tax = (invoice.total_taxes ?? []).reduce((sum, line) => sum + line.amount, 0);
  // Credit balances, partial payments, mixed payments, and shipping need a separate allocation policy.
  if (invoice.amount_paid !== invoice.total || tax > invoice.total) return null;
  const payments = invoice.payments?.data.filter(payment => payment.status === 'paid') ?? [];
  if (payments.length > 1) return null;
  const payment = payments[0]?.payment.payment_intent;
  const details = payment && typeof payment === 'object' ? payment.presentment_details : undefined;
  if (details && (payment as { amount_received: number }).amount_received !== invoice.amount_paid) return null;
  const subscription = invoice.parent.subscription_details.subscription;
  return { subscriptionId: typeof subscription === 'string' ? subscription : subscription.id,
    clientId: metadata.matrix_google_client_id, consentExpiresAt: Number(metadata.matrix_google_expires_at), adUserData: metadata.matrix_google_ad_user_data,
    adPersonalization: metadata.matrix_google_ad_personalization,
    event: { ...buildEvent({ transactionId: invoice.id, amount: invoice.amount_paid, tax, currency: invoice.currency,
      presentment: details, planSlug: metadata.matrix_plan_slug, interval: metadata.matrix_billing_interval }),
      trial_converted: Number(metadata.matrix_trial_days) > 0 } };
}
