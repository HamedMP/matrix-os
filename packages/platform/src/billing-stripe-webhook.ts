/**
 * Stripe webhook route plus Stripe event projection helpers.
 *
 * Extracted from ./billing-routes.ts (Phase 1-A4). Pure move: no logic changes.
 */

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';
import { z } from 'zod/v4';
import {
  cancelOutstandingBillingRuntimeActions,
  consumeCardTrial,
  enqueueBillingRuntimeAction,
  getActiveUserMachineByClerkId,
  getBillingCustomerByStripeCustomerId,
  getBillingSubscriptionByStripeId,
  insertBillingWebhookEvent,
  listCurrentBillingSubscriptions,
  projectTrialInvoiceEvent,
  resolveCheckoutAttempt,
  runBillingWebhookTransaction,
  upsertBillingCustomer,
  upsertBillingSubscription,
  type BillingSubscriptionRecord,
  type PlatformDB,
  type UserMachineRecord,
} from './db.js';
import type { MatrixHostedBillingRegionSlug } from '@matrix-os/contracts';
import {
  DEFAULT_BILLING_PLAN_DEFINITIONS,
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
  type BillingEntitlement,
  type MatrixBillingPlanSlug,
  type StripePriceCatalog,
  type StripeSubscriptionProjection,
  type BillingEntitlementStatus,
} from './billing.js';
import { processAiCreditWebhookEvent } from './ai-credit-checkout-webhook.js';
import { RuntimeSlotSchema } from './customer-vps-schema.js';
import { deliverRedditAttribution } from './reddit-purchase-attribution.js';
import {
  BILLING_CHECKOUT_COMPLETED_EVENT,
  BILLING_CHECKOUT_EXPIRED_EVENT,
  BILLING_INVOICE_PAID_EVENT,
  BILLING_INVOICE_PAYMENT_FAILED_EVENT,
  BILLING_SUBSCRIPTION_UPDATED_EVENT,
  BILLING_TRIAL_CONVERTED_EVENT,
  BILLING_TRIAL_PAYMENT_FAILED_EVENT,
  BILLING_TRIAL_STARTED_EVENT,
  BILLING_TRIAL_WILL_END_EVENT,
  HistoricalBillingRegionSlugSchema,
  MAX_STRIPE_API_TIMEOUT_MS,
  STRIPE_WEBHOOK_BODY_LIMIT,
  TRIAL_PAYMENT_SUSPEND_DELAY_MS,
  createTelemetryEmitter,
  type StripeWebhookEvent,
  resolveRuntimePlacement,
  resolveBillingRouteContext,
  type BillingRouteOptions,
} from './billing-route-helpers.js';

const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]{1,128}$/;
function buildSubscriptionTelemetryProperties(input: {
  entitlement: BillingEntitlement;
  recurringItem: StripeSubscriptionProjection['items'][number] | undefined;
  runtimeSlot: string;
  regionSlug: MatrixHostedBillingRegionSlug | null;
  machine: Pick<UserMachineRecord, 'serverType' | 'location' | 'hetznerServerId'> | undefined;
}): Record<string, string | number | boolean | undefined> {
  const { entitlement, recurringItem, runtimeSlot, machine } = input;
  const planSlug = entitlement.planSlug === 'internal' ? undefined : entitlement.planSlug;
  const placement = resolveRuntimePlacement(machine?.location, input.regionSlug);
  const hasRecurringPrice = recurringItem?.unitAmountMinor !== null
    && recurringItem?.unitAmountMinor !== undefined
    && recurringItem.currency !== null
    && recurringItem.currency !== undefined
    && recurringItem.interval !== null
    && recurringItem.interval !== undefined
    && recurringItem.intervalCount !== null
    && recurringItem.intervalCount !== undefined
    && recurringItem.quantity !== null
    && recurringItem.quantity !== undefined;
  return {
    plan_slug: planSlug,
    subscription_status: entitlement.status,
    billing_interval: recurringItem?.interval ?? entitlement.billingInterval ?? undefined,
    ...(hasRecurringPrice ? {
      recurring_unit_amount_minor: recurringItem.unitAmountMinor!,
      recurring_total_amount_minor: recurringItem.unitAmountMinor! * recurringItem.quantity!,
      currency: recurringItem.currency!,
      price_interval_count: recurringItem.intervalCount!,
      price_quantity: recurringItem.quantity!,
    } : {}),
    runtime_slot: runtimeSlot,
    ...(placement ? {
      region_slug: placement.slug,
      location_code: placement.location,
      location_label: placement.label,
      country: placement.countryLabel,
      network_zone: placement.networkZone,
    } : {}),
    ...(machine?.serverType ? { server_type: machine.serverType } : {}),
    ...(machine ? { provider: 'hetzner' } : {}),
    included_runtime_slots: entitlement.includedRuntimeSlots,
    addon_runtime_slots: entitlement.addonRuntimeSlots,
    max_runtime_slots: entitlement.maxRuntimeSlots,
  };
}


function isSubscriptionEvent(type: string): boolean {
  return (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted' ||
    type === 'customer.subscription.trial_will_end'
  );
}

async function projectSubscription(
  db: PlatformDB,
  value: unknown,
  currentTime: Date,
): Promise<(StripeSubscriptionProjection & {
  runtimeSlot: string;
  regionSlug: MatrixHostedBillingRegionSlug | null;
  prebillingIntentId: string | null;
}) | null> {
  if (!value || typeof value !== 'object') return null;
  const sub = value as {
    id?: unknown;
    customer?: unknown;
    status?: unknown;
    current_period_end?: unknown;
    trial_start?: unknown;
    trial_end?: unknown;
    metadata?: unknown;
    items?: { data?: unknown };
  };
  if (typeof sub.id !== 'string' || typeof sub.customer !== 'string') return null;
  let customer = await getBillingCustomerByStripeCustomerId(db, sub.customer);
  if (!customer) {
    const clerkUserId = readClerkUserIdFromStripeMetadata(sub.metadata);
    if (!clerkUserId) return null;
    const nowIso = currentTime.toISOString();
    await upsertBillingCustomer(db, {
      clerkUserId,
      stripeCustomerId: sub.customer,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    customer = await getBillingCustomerByStripeCustomerId(db, sub.customer);
    if (!customer) return null;
  }
  const status = normalizeSubscriptionStatus(sub.status);
  const existing = await getBillingSubscriptionByStripeId(db, sub.id);
  const runtimeSlot = readRuntimeSlotFromStripeMetadata(sub.metadata) ?? 'primary';
  const data = Array.isArray(sub.items?.data) ? sub.items.data : [];
  const itemPeriodBoundaries = data.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as {
      current_period_start?: unknown;
      current_period_end?: unknown;
    };
    const boundary = status === 'past_due' || status === 'unpaid'
      ? candidate.current_period_start
      : candidate.current_period_end;
    return typeof boundary === 'number' ? [boundary] : [];
  });
  const itemPeriodBoundary = itemPeriodBoundaries.length > 0
    ? Math.min(...itemPeriodBoundaries)
    : null;
  return {
    clerkUserId: customer.clerkUserId,
    stripeCustomerId: customer.stripeCustomerId,
    stripeSubscriptionId: sub.id,
    runtimeSlot,
    regionSlug: readRegionSlugFromStripeMetadata(sub.metadata),
    prebillingIntentId: readPrebillingIntentIdFromStripeMetadata(sub.metadata),
    status,
    currentPeriodEnd: typeof sub.current_period_end === 'number'
      ? epochSecondsToIso(sub.current_period_end)
      : (itemPeriodBoundary === null ? null : epochSecondsToIso(itemPeriodBoundary)),
    trialStartedAt: typeof sub.trial_start === 'number'
      ? epochSecondsToIso(sub.trial_start)
      : (existing?.trialStartedAt ?? null),
    trialEndsAt: typeof sub.trial_end === 'number'
      ? epochSecondsToIso(sub.trial_end)
      : (existing?.trialEndsAt ?? null),
    trialConvertedAt: existing?.trialConvertedAt ?? null,
    firstTrialPaymentFailedAt: existing?.firstTrialPaymentFailedAt ?? null,
    items: data.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as {
        price?: {
          id?: unknown;
          unit_amount?: unknown;
          currency?: unknown;
          recurring?: { interval?: unknown; interval_count?: unknown };
        };
        quantity?: unknown;
      };
      if (typeof candidate.price?.id !== 'string') return [];
      const interval = candidate.price.recurring?.interval === 'month'
        ? 'monthly'
        : candidate.price.recurring?.interval === 'year'
          ? 'annual'
          : null;
      return [{
        priceId: candidate.price.id,
        quantity: typeof candidate.quantity === 'number' && Number.isInteger(candidate.quantity) && candidate.quantity > 0
          ? candidate.quantity
          : 1,
        unitAmountMinor: typeof candidate.price.unit_amount === 'number'
          && Number.isInteger(candidate.price.unit_amount)
          && candidate.price.unit_amount >= 0
          ? candidate.price.unit_amount
          : null,
        currency: typeof candidate.price.currency === 'string' && /^[a-z]{3}$/.test(candidate.price.currency)
          ? candidate.price.currency
          : null,
        interval,
        intervalCount: typeof candidate.price.recurring?.interval_count === 'number'
          && Number.isInteger(candidate.price.recurring.interval_count)
          && candidate.price.recurring.interval_count > 0
          ? candidate.price.recurring.interval_count
          : null,
      }];
    }),
  };
}

function readRuntimeSlotFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = RuntimeSlotSchema.safeParse((metadata as { matrix_runtime_slot?: unknown }).matrix_runtime_slot);
  return parsed.success ? parsed.data : null;
}

function readRegionSlugFromStripeMetadata(metadata: unknown): MatrixHostedBillingRegionSlug | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = HistoricalBillingRegionSlugSchema.safeParse(
    (metadata as { matrix_region_slug?: unknown }).matrix_region_slug,
  );
  return parsed.success ? parsed.data : null;
}

function readPrebillingIntentIdFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(
    (metadata as { matrix_prebilling_intent_id?: unknown }).matrix_prebilling_intent_id,
  );
  return parsed.success ? parsed.data : null;
}

async function recomputeStripeSummary(
  db: PlatformDB,
  clerkUserId: string,
  priceCatalog: StripePriceCatalog,
  env: NodeJS.ProcessEnv,
  now: Date,
): Promise<BillingEntitlement | null> {
  const subscriptions = await listCurrentBillingSubscriptions(db, clerkUserId, now.toISOString());
  if (subscriptions.length === 0) return null;
  const runtimeCatalog = loadRuntimeCatalog(env);
  const projected = subscriptions.map((subscription) => ({
    runtimeSlot: subscription.runtimeSlot,
    entitlement: deriveStripeEntitlement({
      clerkUserId: subscription.clerkUserId,
      stripeCustomerId: subscription.stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialStartedAt: subscription.trialStartedAt,
      trialEndsAt: subscription.trialEndsAt,
      trialConvertedAt: subscription.trialConvertedAt,
      firstTrialPaymentFailedAt: subscription.firstTrialPaymentFailedAt,
      items: [{ priceId: subscription.stripePriceId, quantity: 1 }],
    }, { priceCatalog, runtimeCatalog, now }),
  }));
  const accessible = projected.filter(({ entitlement }) => getRuntimeAccessDecision(entitlement, now).runtimeProxyAllowed);
  const representative = accessible.find(({ runtimeSlot }) => runtimeSlot === 'primary')
    ?? accessible[0]
    ?? projected.find(({ runtimeSlot }) => runtimeSlot === 'primary')
    ?? projected[0];
  if (!representative) return null;
  return {
    ...representative.entitlement,
    maxRuntimeSlots: accessible.length,
    includedRuntimeSlots: accessible.length,
    addonRuntimeSlots: 0,
    updatedAt: now.toISOString(),
  };
}

interface StripeInvoiceProjection {
  stripeSubscriptionId: string;
  billingReason: string;
  createdAt: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
}

function readInvoiceProjection(value: unknown): StripeInvoiceProjection | null {
  if (!value || typeof value !== 'object') return null;
  const invoice = value as {
    created?: unknown;
    billing_reason?: unknown;
    amount_due?: unknown;
    amount_paid?: unknown;
    currency?: unknown;
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
  };
  const subscription = readExpandableStripeId(
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription,
  );
  if (
    !subscription
    || typeof invoice.created !== 'number'
    || typeof invoice.billing_reason !== 'string'
    || typeof invoice.amount_due !== 'number'
    || !Number.isSafeInteger(invoice.amount_due)
    || invoice.amount_due < 0
    || typeof invoice.amount_paid !== 'number'
    || !Number.isSafeInteger(invoice.amount_paid)
    || invoice.amount_paid < 0
    || typeof invoice.currency !== 'string'
    || !/^[a-z]{3}$/.test(invoice.currency)
  ) {
    return null;
  }
  return {
    stripeSubscriptionId: subscription,
    billingReason: invoice.billing_reason,
    createdAt: epochSecondsToIso(invoice.created),
    amountDueMinor: invoice.amount_due,
    amountPaidMinor: invoice.amount_paid,
    currency: invoice.currency,
  };
}

function isFirstPostTrialInvoice(
  invoice: StripeInvoiceProjection,
  trialEndsAt: string | null,
  trialConvertedAt: string | null,
): boolean {
  return invoice.billingReason === 'subscription_cycle'
    && trialEndsAt !== null
    && trialConvertedAt === null
    && Date.parse(invoice.createdAt) >= Date.parse(trialEndsAt);
}

function readExpandableStripeId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return readStripeObjectId(value);
}

function readStripeObjectId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readClerkUserIdFromCheckoutSession(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as { client_reference_id?: unknown; metadata?: unknown };
  if (typeof session.client_reference_id === 'string' && CLERK_USER_ID_PATTERN.test(session.client_reference_id)) {
    return session.client_reference_id;
  }
  return readClerkUserIdFromStripeMetadata(session.metadata);
}

function readClerkUserIdFromStripeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const clerkUserId = (metadata as { clerk_user_id?: unknown }).clerk_user_id;
  return typeof clerkUserId === 'string' && CLERK_USER_ID_PATTERN.test(clerkUserId)
    ? clerkUserId
    : null;
}

function normalizeSubscriptionStatus(value: unknown): BillingEntitlementStatus {
  if (
    value === 'active' ||
    value === 'trialing' ||
    value === 'past_due' ||
    value === 'canceled' ||
    value === 'incomplete' ||
    value === 'unpaid'
  ) {
    return value;
  }
  return 'ended';
}

function epochSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

export function getPublicBillingPlans() {
  return DEFAULT_BILLING_PLAN_DEFINITIONS.map((plan) => ({
    slug: plan.slug,
    marketingName: plan.marketingName,
    monthlyUsd: plan.monthlyUsd,
    includedRuntimeSlots: plan.includedRuntimeSlots,
  }));
}

export function createBillingStripeWebhookRoutes(options: BillingRouteOptions): Hono {
  const app = new Hono();
  const { env, now, persistEntitlement } = resolveBillingRouteContext(options);
  const emitTelemetry = createTelemetryEmitter(options.captureEvent);

  app.post('/webhooks/stripe', bodyLimit({ maxSize: STRIPE_WEBHOOK_BODY_LIMIT }), async (c) => {
    const signature = c.req.header('stripe-signature');
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) return c.json({ error: 'Invalid webhook' }, 400);

    const rawBody = await c.req.text();
    let event: StripeWebhookEvent;
    try {
      event = options.stripe.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: unknown) {
      console.warn('[billing] invalid Stripe webhook signature:', err instanceof Error ? err.message : String(err));
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'invalid_signature' },
      });
      return c.json({ error: 'Invalid webhook' }, 400);
    }

    let preparationToResume: { intentId: string; clerkUserId: string } | undefined;
    try {
      const webhookProcessedAt = now();
      const result = await runBillingWebhookTransaction(options.db, async (trx) => {
        const inserted = await insertBillingWebhookEvent(trx, {
          stripeEventId: event.id,
          eventType: event.type,
          createdAtFromStripe: epochSecondsToIso(event.created),
          processedAt: webhookProcessedAt.toISOString(),
          status: 'processed',
          errorCode: null,
        });
        if (!inserted.inserted) {
          return { received: true, duplicate: true };
        }

        const aiCreditResult = await processAiCreditWebhookEvent({
          event, trx, repository: options.fundedAiRepository, at: webhookProcessedAt.toISOString(),
        });
        if (aiCreditResult) return aiCreditResult;

        // Checkout session lifecycle drives the settling-attempt status: a
        // confirmed payment marks the attempt `paid` (sticky), an expiry marks
        // it `expired`. Both only transition `open` rows.
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
          const sessionId = readStripeObjectId(event.data.object);
          if (sessionId) {
            await resolveCheckoutAttempt(
              trx,
              sessionId,
              event.type === 'checkout.session.completed' ? 'paid' : 'expired',
              webhookProcessedAt.toISOString(),
              true,
            );
            if (event.type === 'checkout.session.expired') {
              const checkoutObject = event.data.object && typeof event.data.object === 'object'
                ? event.data.object as { metadata?: unknown }
                : undefined;
              const intentId = readPrebillingIntentIdFromStripeMetadata(checkoutObject?.metadata);
              const clerkUserId = readClerkUserIdFromCheckoutSession(event.data.object);
              await options.prebilling?.expireCheckout(trx, {
                stripeSessionId: sessionId,
                ...(intentId ? { intentId } : {}),
                ...(clerkUserId ? { clerkUserId } : {}),
                now: webhookProcessedAt.toISOString(),
              });
            }
          }
          emitTelemetry(
            event.type === 'checkout.session.completed'
              ? BILLING_CHECKOUT_COMPLETED_EVENT
              : BILLING_CHECKOUT_EXPIRED_EVENT,
            {
              distinctId: readClerkUserIdFromCheckoutSession(event.data.object) ?? undefined,
              properties: { stripe_event_type: event.type },
            },
          );
          return { received: true, processed: true };
        }

        if (!isSubscriptionEvent(event.type)) {
          if (event.type !== 'invoice.paid' && event.type !== 'invoice.payment_failed') {
            return { received: true, ignored: true };
          }
          const invoice = readInvoiceProjection(event.data.object);
          if (!invoice) return { received: true, ignored: true };
          const subscription = await getBillingSubscriptionByStripeId(trx, invoice.stripeSubscriptionId);
          if (!subscription) return { received: true, ignored: true };
          emitTelemetry(
            event.type === 'invoice.paid'
              ? BILLING_INVOICE_PAID_EVENT
              : BILLING_INVOICE_PAYMENT_FAILED_EVENT,
            {
              distinctId: subscription.clerkUserId,
              properties: {
                amount_due_minor: invoice.amountDueMinor,
                amount_paid_minor: invoice.amountPaidMinor,
                currency: invoice.currency,
                plan_slug: subscription.planSlug,
                runtime_slot: subscription.runtimeSlot,
              },
            },
          );
          if (!isFirstPostTrialInvoice(invoice, subscription.trialEndsAt, subscription.trialConvertedAt)) {
            return { received: true, ignored: true };
          }
          const paymentIsRecoveringFailedTrial = Boolean(subscription.firstTrialPaymentFailedAt);
          const eventAt = epochSecondsToIso(event.created);
          const invoiceProjection = await projectTrialInvoiceEvent(trx, {
            stripeSubscriptionId: invoice.stripeSubscriptionId,
            type: event.type,
            eventCreatedAt: eventAt,
            eventId: event.id,
            lifecycleAt: eventAt,
            updatedAt: webhookProcessedAt.toISOString(),
          });
          if (!invoiceProjection?.applied) return { received: true, ignored: true };
          if (!invoiceProjection.lifecycleChanged) return { received: true, processed: true };
          const updated = invoiceProjection.subscription;
          if (event.type === 'invoice.payment_failed') {
            const canceledResumes = await cancelOutstandingBillingRuntimeActions(
              trx,
              updated.stripeSubscriptionId,
              'resume',
              webhookProcessedAt.toISOString(),
            );
            await enqueueBillingRuntimeAction(trx, {
              clerkUserId: updated.clerkUserId,
              runtimeSlot: updated.runtimeSlot,
              stripeSubscriptionId: updated.stripeSubscriptionId,
              action: 'suspend',
              reason: 'trial_payment_failed',
              executeAfter: canceledResumes.running > 0
                ? webhookProcessedAt.toISOString()
                : new Date(Date.parse(eventAt) + TRIAL_PAYMENT_SUSPEND_DELAY_MS).toISOString(),
              createdAt: webhookProcessedAt.toISOString(),
            });
            emitTelemetry(BILLING_TRIAL_PAYMENT_FAILED_EVENT, {
              distinctId: updated.clerkUserId,
              properties: { billing_interval: updated.billingInterval ?? undefined },
            });
          } else {
            const canceledSuspensions = await cancelOutstandingBillingRuntimeActions(
              trx,
              updated.stripeSubscriptionId,
              'suspend',
              webhookProcessedAt.toISOString(),
            );
            const machine = paymentIsRecoveringFailedTrial
              ? await getActiveUserMachineByClerkId(trx, updated.clerkUserId, updated.runtimeSlot)
              : undefined;
            const recoveryRequiresResume = paymentIsRecoveringFailedTrial && (
              canceledSuspensions.running > 0
              || machine?.status === 'suspended'
              || machine?.status === 'suspending'
            );
            if (recoveryRequiresResume) {
              await enqueueBillingRuntimeAction(trx, {
                clerkUserId: updated.clerkUserId,
                runtimeSlot: updated.runtimeSlot,
                stripeSubscriptionId: updated.stripeSubscriptionId,
                action: 'resume',
                reason: 'payment_recovered',
                executeAfter: webhookProcessedAt.toISOString(),
                createdAt: webhookProcessedAt.toISOString(),
              });
            }
            emitTelemetry(BILLING_TRIAL_CONVERTED_EVENT, {
              distinctId: updated.clerkUserId,
              properties: { billing_interval: updated.billingInterval ?? undefined },
            });
          }
          const priceCatalog = loadStripePriceCatalog(env);
          const summary = await recomputeStripeSummary(trx, updated.clerkUserId, priceCatalog, env, webhookProcessedAt);
          if (summary) await persistEntitlement(trx, summary);
          return { received: true, processed: true };
        }

        const projection = await projectSubscription(trx, event.data.object, webhookProcessedAt);
        if (!projection) return { received: true, ignored: true };

        const priceCatalog = loadStripePriceCatalog(env);
        const entitlement = deriveStripeEntitlement(projection, {
          priceCatalog,
          runtimeCatalog: loadRuntimeCatalog(env),
          now: webhookProcessedAt,
        });
        const priceEntry = entitlement.stripePriceId
          ? priceCatalog.priceToPlan.get(entitlement.stripePriceId)
          : undefined;
        if (!priceEntry || !entitlement.stripePriceId) {
          return { received: true, ignored: true };
        }
        const recurringItem = projection.items.find(
          (item) => item.priceId === entitlement.stripePriceId,
        );
        const projectionApplied = await upsertBillingSubscription(trx, {
          stripeSubscriptionId: projection.stripeSubscriptionId,
          stripeCustomerId: projection.stripeCustomerId,
          clerkUserId: projection.clerkUserId,
          runtimeSlot: projection.runtimeSlot,
          planSlug: priceEntry.planSlug,
          stripePriceId: entitlement.stripePriceId,
          billingInterval: recurringItem?.interval ?? priceEntry.interval,
          priceUnitAmountMinor: recurringItem?.unitAmountMinor ?? null,
          priceCurrency: recurringItem?.currency ?? null,
          priceIntervalCount: recurringItem?.intervalCount ?? null,
          priceQuantity: recurringItem?.quantity ?? 1,
          status: entitlement.status,
          currentPeriodEnd: projection.currentPeriodEnd ?? null,
          gracePeriodEndsAt: entitlement.gracePeriodEndsAt,
          trialStartedAt: projection.trialStartedAt ?? null,
          trialEndsAt: projection.trialEndsAt ?? null,
          trialConvertedAt: projection.trialConvertedAt ?? null,
          firstTrialPaymentFailedAt: projection.firstTrialPaymentFailedAt ?? null,
          latestEventCreatedAt: epochSecondsToIso(event.created),
          latestEventId: event.id,
          updatedAt: webhookProcessedAt.toISOString(),
        });
        if (!projectionApplied) return { received: true, processed: true };
        if (projection.status === 'trialing' && !projection.firstTrialPaymentFailedAt) {
          const canceledSuspensions = await cancelOutstandingBillingRuntimeActions(
            trx,
            projection.stripeSubscriptionId,
            'suspend',
            webhookProcessedAt.toISOString(),
          );
          const machine = await getActiveUserMachineByClerkId(
            trx,
            projection.clerkUserId,
            projection.runtimeSlot,
          );
          if (
            canceledSuspensions.running > 0
            || machine?.status === 'suspended'
            || machine?.status === 'suspending'
          ) {
            await enqueueBillingRuntimeAction(trx, {
              clerkUserId: projection.clerkUserId,
              runtimeSlot: projection.runtimeSlot,
              stripeSubscriptionId: projection.stripeSubscriptionId,
              action: 'resume',
              reason: 'billing_recovered',
              executeAfter: webhookProcessedAt.toISOString(),
              createdAt: webhookProcessedAt.toISOString(),
            });
          }
        }
        const summary = await recomputeStripeSummary(trx, projection.clerkUserId, priceCatalog, env, webhookProcessedAt);
        if (summary) await persistEntitlement(trx, summary);
        if (
          summary
          && projection.prebillingIntentId
          && getRuntimeAccessDecision(summary, webhookProcessedAt).runtimeProxyAllowed
        ) {
          if (!options.prebilling) throw new Error('prebilling_authorization_unavailable');
          const authorization = await options.prebilling.authorizeSubscription(trx, {
            intentId: projection.prebillingIntentId,
            clerkUserId: projection.clerkUserId,
            runtimeSlot: projection.runtimeSlot,
            now: webhookProcessedAt.toISOString(),
          });
          if (!authorization.authorized) {
            preparationToResume = {
              intentId: projection.prebillingIntentId,
              clerkUserId: projection.clerkUserId,
            };
          }
        }
        const telemetryMachine = await getActiveUserMachineByClerkId(
          trx,
          projection.clerkUserId,
          projection.runtimeSlot,
        );
        emitTelemetry(BILLING_SUBSCRIPTION_UPDATED_EVENT, {
          distinctId: entitlement.clerkUserId,
          properties: buildSubscriptionTelemetryProperties({
            entitlement,
            recurringItem,
            runtimeSlot: projection.runtimeSlot,
            regionSlug: projection.regionSlug,
            machine: telemetryMachine,
          }),
        });
        if (event.type === 'customer.subscription.created' && projection.status === 'trialing') {
          await consumeCardTrial(trx, projection.clerkUserId, webhookProcessedAt.toISOString());
          emitTelemetry(BILLING_TRIAL_STARTED_EVENT, { distinctId: projection.clerkUserId });
        }
        if (event.type === 'customer.subscription.trial_will_end') {
          emitTelemetry(BILLING_TRIAL_WILL_END_EVENT, { distinctId: projection.clerkUserId });
        }
        if (
          projection.trialEndsAt
          && !projection.trialConvertedAt
          && (projection.status === 'canceled' || projection.status === 'unpaid' || projection.status === 'ended')
        ) {
          const canceledResumes = await cancelOutstandingBillingRuntimeActions(
            trx,
            projection.stripeSubscriptionId,
            'resume',
            webhookProcessedAt.toISOString(),
          );
          await enqueueBillingRuntimeAction(trx, {
            clerkUserId: projection.clerkUserId,
            runtimeSlot: projection.runtimeSlot,
            stripeSubscriptionId: projection.stripeSubscriptionId,
            action: 'suspend',
            reason: 'trial_ended_unpaid',
            executeAfter: canceledResumes.running > 0
              ? webhookProcessedAt.toISOString()
              : new Date(
                Date.parse(projection.trialEndsAt) + TRIAL_PAYMENT_SUSPEND_DELAY_MS,
              ).toISOString(),
            createdAt: webhookProcessedAt.toISOString(),
          });
        }
        return { received: true, processed: true };
      });
      if (preparationToResume && options.prebilling) {
        void options.prebilling.resumePreparation(preparationToResume).catch((err: unknown) => {
          console.error(
            `[billing] paid preparation kick failed intent=${preparationToResume?.intentId ?? 'unknown'}`,
            err instanceof Error ? err.name : typeof err,
          );
        });
      }
      const clearSubscriptionAttribution = options.stripe.clearSubscriptionAttribution?.bind(options.stripe);
      await deliverRedditAttribution(
        event,
        options.redditConversions,
        clearSubscriptionAttribution ? { clearSubscriptionAttribution } : undefined,
      );
      return c.json(result, 200);
    } catch (err: unknown) {
      console.error('[billing] Stripe webhook processing failed:', err instanceof Error ? err.message : String(err));
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'processing_error', event_type: event.type },
      });
      return c.json({ error: 'Webhook processing failed' }, 500);
    }
  });
  return app;
}
