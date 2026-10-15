import { createGooglePurchaseSender } from './google-purchases.js';
import { deliverGooglePurchases, enqueueGooglePurchase, rememberSkippedGoogleAcquisition } from './google-purchase-store.js';
import { invoiceTrackingEvent, invoiceAcquisitionIdentity } from './tracking-events.js';
import { type Context } from 'hono';
import { withAccountDeletionOwnerLock } from '../account-deletion/admission.js';

import { MATRIX_TELEMETRY_EVENTS } from '@matrix-os/observability';

import {
  cancelOutstandingBillingRuntimeActions,
  enqueueBillingRuntimeAction,
  consumeCardTrial,
  getBillingSubscriptionByStripeId,
  getActiveUserMachineByClerkId,
  insertBillingWebhookEvent,
  projectTrialInvoiceEvent,
  resolveCheckoutAttempt,
  runBillingWebhookTransaction,
  upsertBillingEntitlement,
  upsertBillingSubscription,
} from '../db.js';
import {
  deriveStripeEntitlement,
  getRuntimeAccessDecision,
  loadRuntimeCatalog,
  loadStripePriceCatalog,
} from '../billing.js';

import { processAiCreditWebhookEvent } from '../ai-credit-checkout-webhook.js';

import { deliverRedditAttribution } from '../reddit-purchase-attribution.js';

import { type StripeWebhookEvent } from '../billing/stripe-client.js';

import { buildSubscriptionTelemetryProperties } from '../billing/checkout-support.js';
import {
  epochSecondsToIso,
  isFirstPostTrialInvoice,
  isSubscriptionEvent,
  projectSubscription,
  readClerkUserIdFromCheckoutSession,
  readClerkUserIdFromStripeMetadata,
  readInvoiceProjection,
  readPrebillingIntentIdFromStripeMetadata,
  readStripeObjectId,
  recomputeStripeSummary,
} from '../billing/stripe-webhook-projection.js';

import type { createBillingRoutes } from '../billing-routes.js';
const BILLING_CHECKOUT_COMPLETED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_COMPLETED ?? 'matrix_billing_checkout_completed';
const BILLING_CHECKOUT_EXPIRED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_EXPIRED ?? 'matrix_billing_checkout_expired';
const BILLING_SUBSCRIPTION_UPDATED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_SUBSCRIPTION_UPDATED ?? 'matrix_billing_subscription_updated';
const BILLING_INVOICE_PAID_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAID ?? 'matrix_billing_invoice_paid';
const BILLING_INVOICE_PAYMENT_FAILED_EVENT =
  MATRIX_TELEMETRY_EVENTS.BILLING_INVOICE_PAYMENT_FAILED ?? 'matrix_billing_invoice_payment_failed';
const BILLING_TRIAL_STARTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_STARTED;
const BILLING_TRIAL_WILL_END_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_WILL_END;
const BILLING_TRIAL_CONVERTED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_CONVERTED;
const BILLING_TRIAL_PAYMENT_FAILED_EVENT = MATRIX_TELEMETRY_EVENTS.BILLING_TRIAL_PAYMENT_FAILED;
const TRIAL_PAYMENT_SUSPEND_DELAY_MS = 24 * 60 * 60 * 1000;

export function createStripeWebhookHandler(options: Parameters<typeof createBillingRoutes>[0], emitTelemetry: NonNullable<Parameters<typeof createBillingRoutes>[0]['captureEvent']>) {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const persistEntitlement = options.upsertEntitlement ?? upsertBillingEntitlement;
  return async (c: Context) => {
    const signature = c.req.header('stripe-signature');
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!signature || !webhookSecret) return c.json({ error: 'Invalid webhook' }, 400);

    const rawBody = await c.req.text();
    let event: StripeWebhookEvent;
    try {
      event = options.stripe.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: unknown) {
      console.warn('[billing] invalid Stripe webhook signature:', err instanceof Error ? err.name : typeof err);
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'invalid_signature' },
      });
      return c.json({ error: 'Invalid webhook' }, 400);
    }

    // Queue the signed invoice immediately; payment-detail lookup belongs to
    // delivery after billing commits, so analytics cannot delay access recovery.
    const googlePurchase = event.type === 'invoice.paid' ? invoiceTrackingEvent(event.data.object) : null;
    const googleAcquisition = event.type === 'invoice.paid' ? invoiceAcquisitionIdentity(event.data.object) : null;
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

        if (googleAcquisition) {
          const owner = readClerkUserIdFromStripeMetadata(
            (event.data.object as { parent?: { subscription_details?: { metadata?: unknown } } }).parent?.subscription_details?.metadata,
          );
          if (owner) await withAccountDeletionOwnerLock(trx, owner, async (locked, admission) => {
            if (!admission.newWorkAllowed) return;
            if (googlePurchase) await enqueueGooglePurchase(locked, {
              ...googlePurchase, eventAt: event.created * 1000,
              needsInvoiceLookup: Boolean(options.stripe.retrieveTrackingInvoice),
            }, webhookProcessedAt.toISOString(), owner);
            else await rememberSkippedGoogleAcquisition(locked, googleAcquisition, webhookProcessedAt.toISOString(), owner);
          }, env);
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
      if (googlePurchase && env.GOOGLE_ANALYTICS_MEASUREMENT_ID && env.GOOGLE_ANALYTICS_API_SECRET) {
        const delivery = await deliverGooglePurchases(options.db, createGooglePurchaseSender(env, fetch,
          options.stripe.retrieveTrackingInvoice?.bind(options.stripe)), now().toISOString(), googlePurchase.subscriptionId);
        if (delivery.failed || delivery.pending) throw new Error('GooglePurchaseDeliveryError');
      }
      const clearSubscriptionAttribution = options.stripe.clearSubscriptionAttribution?.bind(options.stripe);
      await deliverRedditAttribution(
        event,
        options.redditConversions,
        clearSubscriptionAttribution ? { clearSubscriptionAttribution } : undefined,
      );
      return c.json(result, 200);
    } catch (err: unknown) {
      console.error('[billing] Stripe webhook processing failed:', err instanceof Error ? err.name : typeof err);
      emitTelemetry(MATRIX_TELEMETRY_EVENTS.BILLING_WEBHOOK_FAILED, {
        properties: { reason: 'processing_error', event_type: event.type },
      });
      return c.json({ error: 'Webhook processing failed' }, 500);
    }
  };
}
