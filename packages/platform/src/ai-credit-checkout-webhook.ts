import { z } from "zod/v4";
import type { AiFundedPolicyRepository } from "./ai-funded-policy-repository.js";
import {
  assertAiCreditCheckoutMetadata,
  isAiCreditCheckoutObject,
  parseAiCreditCheckoutSession,
  readAiCreditCheckoutRequestId,
  type AiCreditCheckoutClaimExpectation,
} from "./ai-credit-checkout.js";
import {
  getClaimByPaymentReference,
  getClaimByRequestId,
  markClaimSession,
  reverseClaimCredit,
  settleWonDisputeCredit,
  type AiCreditCheckoutClaim,
} from "./ai-credit-checkout-store.js";
import type { PlatformDB } from "./db.js";

interface StripeWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { object: unknown };
}

const AI_SESSION_EVENTS = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed", "checkout.session.expired",
] as const;
const StripeReferenceSchema = z.string().min(3).max(255);
const StripeExpandableReferenceSchema = z.union([
  StripeReferenceSchema,
  z.object({ id: StripeReferenceSchema }).passthrough(),
]).nullable().optional();
const StripeRefundedChargeSchema = z.object({
  id: StripeReferenceSchema,
  payment_intent: StripeExpandableReferenceSchema,
  amount_refunded: z.number().int().positive(),
  currency: z.string().length(3).regex(/^[a-z]{3}$/),
}).passthrough();
const StripeDisputeSchema = z.object({
  id: StripeReferenceSchema,
  charge: StripeExpandableReferenceSchema,
  payment_intent: StripeExpandableReferenceSchema,
  status: z.string().min(2).max(64).regex(/^[a-z_]+$/),
}).passthrough();

type AiWebhookResult = { received: true; processed: true } | { received: true; ignored: true };

function expandableStripeId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function claimExpectation(claim: AiCreditCheckoutClaim): AiCreditCheckoutClaimExpectation {
  if (claim.package_id !== "usd_5" && claim.package_id !== "usd_10" && claim.package_id !== "usd_25") {
    throw new Error("Funded AI checkout claim package is invalid");
  }
  if (claim.currency !== "usd") throw new Error("Funded AI checkout claim currency is invalid");
  return {
    requestId: claim.request_id, ownerId: claim.owner_id, machineId: claim.machine_id,
    runtimeSlot: claim.runtime_slot, packageId: claim.package_id, priceId: claim.stripe_price_id,
    amountMicrousd: Number(claim.amount_microusd), amountCents: claim.amount_cents, currency: claim.currency,
  };
}

async function processSessionEvent(options: {
  event: StripeWebhookEvent;
  trx: PlatformDB;
  repository: Pick<AiFundedPolicyRepository, "grantCreditInTransaction">;
  at: string;
}): Promise<AiWebhookResult | null> {
  if (!AI_SESSION_EVENTS.includes(options.event.type as typeof AI_SESSION_EVENTS[number])
    || !isAiCreditCheckoutObject(options.event.data.object)) return null;
  const requestId = readAiCreditCheckoutRequestId(options.event.data.object);
  if (!requestId) throw new Error("Funded AI checkout claim is invalid");
  const claim = await getClaimByRequestId(options.trx, requestId, true);
  if (!claim) throw new Error("Funded AI checkout claim is missing");
  const session = parseAiCreditCheckoutSession(options.event.data.object, claimExpectation(claim));
  if (options.event.type === "checkout.session.expired") {
    if (session.status !== "expired" || session.paymentStatus === "paid") {
      throw new Error("Funded AI expired checkout verification failed");
    }
    await markClaimSession(options.trx, {
      requestId, sessionId: session.sessionId, paymentIntentId: session.paymentIntentId,
      status: "expired", at: options.at,
    });
    return { received: true, processed: true };
  }
  if (session.status !== "complete") throw new Error("Funded AI checkout is incomplete");
  if (options.event.type === "checkout.session.async_payment_failed") {
    if (session.paymentStatus === "paid") throw new Error("Funded AI failed payment is marked paid");
    await markClaimSession(options.trx, {
      requestId, sessionId: session.sessionId, paymentIntentId: session.paymentIntentId,
      status: "payment_failed", at: options.at,
    });
    return { received: true, processed: true };
  }
  if (session.paymentStatus !== "paid") {
    if (options.event.type === "checkout.session.async_payment_succeeded") {
      throw new Error("Funded AI async payment is unpaid");
    }
    await markClaimSession(options.trx, {
      requestId, sessionId: session.sessionId, paymentIntentId: session.paymentIntentId,
      status: "awaiting_payment", at: options.at,
    });
    return { received: true, processed: true };
  }
  await markClaimSession(options.trx, {
    requestId, sessionId: session.sessionId, paymentIntentId: session.paymentIntentId,
    status: "paid", at: options.at,
  });
  await options.repository.grantCreditInTransaction(options.trx, {
    entryId: `addon:${session.sessionId}`, identity: session.identity, kind: "addon_grant",
    amountMicrousd: session.amountMicrousd, sourceReference: session.sessionId, expiresAt: null,
  }, options.at);
  const granted = await options.trx.executor.updateTable("ai_credit_checkout_claims").set({
    granted_microusd: session.amountMicrousd, updated_at: options.at,
  }).where("request_id", "=", requestId)
    .where((eb) => eb.or([
      eb("granted_microusd", "=", 0), eb("granted_microusd", "=", session.amountMicrousd),
    ])).returning("request_id").executeTakeFirst();
  if (!granted) throw new Error("Funded AI checkout grant conflicts with claim");
  return { received: true, processed: true };
}

async function processRefundEvent(event: StripeWebhookEvent, trx: PlatformDB, at: string) {
  if (event.type !== "charge.refunded") return null;
  const charge = StripeRefundedChargeSchema.parse(event.data.object);
  const paymentIntentId = expandableStripeId(charge.payment_intent);
  const metadataRequestId = readAiCreditCheckoutRequestId(event.data.object);
  const claim = await getClaimByPaymentReference(trx, paymentIntentId, charge.id)
    ?? (metadataRequestId ? await getClaimByRequestId(trx, metadataRequestId, true) : undefined);
  if (!claim && !metadataRequestId) return { received: true, ignored: true } as const;
  if (!claim || claim.currency !== charge.currency || Number(claim.granted_microusd) <= 0) {
    throw new Error("Funded AI refund claim is missing");
  }
  if (metadataRequestId) assertAiCreditCheckoutMetadata(event.data.object, claimExpectation(claim));
  await trx.executor.updateTable("ai_credit_checkout_claims").set({
    charge_id: charge.id, payment_intent_id: paymentIntentId ?? claim.payment_intent_id,
    refunded_at: at, updated_at: at,
  }).where("request_id", "=", claim.request_id)
    .where((eb) => eb.or([eb("charge_id", "is", null), eb("charge_id", "=", charge.id)]))
    .executeTakeFirstOrThrow();
  await reverseClaimCredit(trx, claim, charge.id, at, false);
  return { received: true, processed: true } as const;
}

async function processDisputeEvent(event: StripeWebhookEvent, trx: PlatformDB, at: string) {
  if (event.type !== "charge.dispute.created" && event.type !== "charge.dispute.closed") return null;
  const dispute = StripeDisputeSchema.parse(event.data.object);
  const chargeId = expandableStripeId(dispute.charge);
  const paymentIntentId = expandableStripeId(dispute.payment_intent);
  const metadataRequestId = readAiCreditCheckoutRequestId(event.data.object);
  const claim = await getClaimByPaymentReference(trx, paymentIntentId, chargeId)
    ?? (metadataRequestId ? await getClaimByRequestId(trx, metadataRequestId, true) : undefined);
  if (!claim && !metadataRequestId) return { received: true, ignored: true } as const;
  if (!claim || !chargeId || Number(claim.granted_microusd) <= 0) {
    throw new Error("Funded AI dispute claim is missing");
  }
  if (event.type === "charge.dispute.closed" && dispute.status !== "won" && dispute.status !== "lost") {
    throw new Error("Funded AI dispute resolution is invalid");
  }
  if (metadataRequestId) assertAiCreditCheckoutMetadata(event.data.object, claimExpectation(claim));
  // Stripe retries and delivery reordering must not turn a terminal dispute
  // back into an open one, or change one terminal resolution into another.
  if (claim.dispute_status === "won" || claim.dispute_status === "lost") {
    return { received: true, processed: true } as const;
  }
  const nextStatus = event.type === "charge.dispute.created" ? "open" : dispute.status;
  const transitioned = await trx.executor.updateTable("ai_credit_checkout_claims").set({
    charge_id: chargeId, payment_intent_id: paymentIntentId ?? claim.payment_intent_id,
    dispute_status: nextStatus,
    updated_at: at,
  }).where("request_id", "=", claim.request_id)
    .where("dispute_status", "in", ["none", "open"])
    .where((eb) => eb.or([eb("charge_id", "is", null), eb("charge_id", "=", chargeId)]))
    .returningAll().executeTakeFirst();
  if (!transitioned) throw new Error("Funded AI dispute transition conflicted");
  if (event.type === "charge.dispute.closed" && dispute.status === "won") {
    await settleWonDisputeCredit(trx, transitioned, at);
  } else {
    await reverseClaimCredit(trx, transitioned, dispute.id, at, true);
  }
  return { received: true, processed: true } as const;
}

export async function processAiCreditWebhookEvent(options: {
  event: StripeWebhookEvent;
  trx: PlatformDB;
  repository?: Pick<AiFundedPolicyRepository, "grantCreditInTransaction">;
  at: string;
}): Promise<AiWebhookResult | null> {
  const isMatrixSession = AI_SESSION_EVENTS.includes(options.event.type as typeof AI_SESSION_EVENTS[number])
    && isAiCreditCheckoutObject(options.event.data.object);
  if (isMatrixSession && !options.repository) throw new Error("Funded AI credit ledger is unavailable");
  if (options.repository) {
    const session = await processSessionEvent({ ...options, repository: options.repository });
    if (session) return session;
  }
  return await processRefundEvent(options.event, options.trx, options.at)
    ?? await processDisputeEvent(options.event, options.trx, options.at);
}
