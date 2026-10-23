import { z } from 'zod/v4';
import { sql } from 'kysely';
import { IsoTimestampSchema } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import type { StripePriceCatalog, StripeSubscriptionProjection } from './billing.js';
import type { AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { readInvoiceProjection } from './billing/stripe-webhook-projection.js';
import { initializeCustomerFundedStarterPolicy } from './customer-funded-starter-policy.js';
import { subscriptionCreditCycle } from './subscription-ai-credit-cycle.js';
import { subscriptionCreditAmount } from './subscription-ai-credit-types.js';
import { issueConfiguredSubscriptionAiCredit, loadSubscriptionAiCreditPolicy, shortenSubscriptionCreditCycle } from './subscription-ai-credit-policy.js';

type Repository = Pick<AiFundedPolicyRepository, 'grantCreditInTransaction'>;
type Context = { db: PlatformDB; repository?: Repository; env: NodeJS.ProcessEnv; now: Date };
const ref = z.string().min(1).max(255);
const second = z.number().int().nonnegative().max(8_640_000_000_000);

export async function issueSubscriptionRuntimeCredit(input: Context, subscriptionId: string): Promise<void> {
  if (!loadSubscriptionAiCreditPolicy(input.env).enabled) return;
  if (!input.repository) throw new Error('Subscription credit ledger is unavailable');
  const sub = await input.db.executor.selectFrom('billing_subscriptions').select(['clerk_user_id', 'runtime_slot'])
    .where('stripe_subscription_id', '=', subscriptionId).executeTakeFirst();
  if (!sub) return;
  const machines = await input.db.executor.selectFrom('user_machines').select('machine_id')
    .where('clerk_user_id', '=', sub.clerk_user_id).where('runtime_slot', '=', sub.runtime_slot)
    .where('deleted_at', 'is', null).where('status', '=', 'running').limit(2).execute();
  if (machines.length !== 1) return;
  const machineId = machines[0]!.machine_id;
  const policy = await input.db.executor.selectFrom('ai_funded_runtime_policies').select('machine_id')
    .where('machine_id', '=', machineId).executeTakeFirst();
  if (!policy) await initializeCustomerFundedStarterPolicy(input.db, machineId,
    { now: input.now.toISOString(), env: input.env, repository: input.repository });
  await issueConfiguredSubscriptionAiCredit({ db: input.db, repository: input.repository, env: input.env, now: input.now,
    identity: { ownerId: sub.clerk_user_id, machineId: machines[0]!.machine_id, runtimeSlot: sub.runtime_slot } });
}

/** Called only after the signed, monotonic billing projection was applied. */
export async function recordSubscriptionCreditTerms(input: Context & { changeAt: Date }, projection: StripeSubscriptionProjection & { runtimeSlot: string }, value: unknown): Promise<void> {
  if (!loadSubscriptionAiCreditPolicy(input.env).enabled) return;
  await withAccountDeletionOwnerLock(input.db, projection.clerkUserId, async (trx, admission) => {
    if (!admission.newWorkAllowed) return;
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${projection.clerkUserId}`}, 0))`.execute(trx.executor);
    const sub = await trx.executor.selectFrom('billing_subscriptions').select(['plan_slug', 'clerk_user_id', 'runtime_slot', 'current_period_end'])
      .where('stripe_subscription_id', '=', projection.stripeSubscriptionId).executeTakeFirstOrThrow();
    if (sub.clerk_user_id !== projection.clerkUserId || sub.runtime_slot !== projection.runtimeSlot) throw new Error('Subscription credit identity mismatch');
    const at = input.now.toISOString();
    if (sub.current_period_end) {
      const cycles = await trx.executor.selectFrom('ai_subscription_credit_cycles').selectAll()
        .where('subscription_id', '=', projection.stripeSubscriptionId).where('owner_id', '=', sub.clerk_user_id)
        .where('cycle_end', '>', sub.current_period_end).where('cycle_end', '>', at).limit(2).forUpdate().execute();
      if (cycles.length > 1) throw new Error('Subscription cancellation requires reconciliation');
      for (const cycle of cycles) await shortenSubscriptionCreditCycle(trx, cycle, sub.current_period_end, at);
    }
    const amount = subscriptionCreditAmount(sub.plan_slug);
    if (!amount) return;
    const previous = await trx.executor.selectFrom('ai_subscription_credit_terms').selectAll()
      .where('subscription_id', '=', projection.stripeSubscriptionId).forUpdate().executeTakeFirst();
    const raw = z.object({ billing_cycle_anchor: second.optional(), start_date: second.optional() }).passthrough().parse(value);
    const seconds = raw.billing_cycle_anchor ?? raw.start_date;
    const anchor = previous?.anchor_at ?? (seconds === undefined ? undefined : new Date(seconds * 1000).toISOString());
    if (!anchor) return; // No guessed first-period dates for historical subscriptions.
    IsoTimestampSchema.parse(anchor);
    const cycle = subscriptionCreditCycle(anchor, input.changeAt);
    if (!cycle) return;
    const oldAmount = previous && previous.observed_plan_slug !== sub.plan_slug && cycle.start !== input.changeAt.toISOString()
      ? subscriptionCreditAmount(previous.observed_plan_slug) ?? 0 : 0;
    const floor = Math.max(amount, oldAmount, previous?.floor_cycle_start === cycle.start ? Number(previous.floor_microusd) : 0);
    await trx.executor.insertInto('ai_subscription_credit_terms').values({ subscription_id: projection.stripeSubscriptionId,
      owner_id: sub.clerk_user_id, runtime_slot: sub.runtime_slot, anchor_at: anchor, observed_plan_slug: sub.plan_slug,
      floor_cycle_start: cycle.start, floor_microusd: floor, updated_at: at,
    }).onConflict(oc => oc.column('subscription_id').doUpdateSet({ observed_plan_slug: sub.plan_slug,
      floor_cycle_start: cycle.start, floor_microusd: floor, updated_at: at })).execute();
    await issueSubscriptionRuntimeCredit({ ...input, db: trx }, projection.stripeSubscriptionId);
  }, input.env);
}

const InvoiceSchema = z.object({ id: ref, customer: ref, status: z.literal('paid'),
  amount_due: z.number().int().nonnegative(), amount_paid: z.number().int().nonnegative(),
  lines: z.object({ has_more: z.literal(false), data: z.array(z.object({
    amount: z.number().int(), type: z.enum(['subscription', 'invoiceitem']).optional(), subscription: ref.nullable().optional(),
    parent: z.object({ type: z.string().max(80), subscription_item_details: z.object({ subscription: ref }).passthrough().nullable().optional() }).passthrough().nullable().optional(),
    price: z.object({ id: ref }).passthrough().nullable().optional(),
    pricing: z.object({ price_details: z.object({ price: ref }).passthrough() }).passthrough().nullable().optional(),
    period: z.object({ start: second, end: second }),
  }).passthrough()).max(100) }).passthrough(),
}).passthrough();

/** A paid event records bounded immutable coverage; failed/unpaid events never do.
 * If it precedes the subscription, returning failure lets Stripe retry it. */
export async function recordSubscriptionCreditPayment(input: Context & { value: unknown; priceCatalog: StripePriceCatalog }): Promise<void> {
  if (!loadSubscriptionAiCreditPolicy(input.env).enabled) return;
  const projection = readInvoiceProjection(input.value);
  const parsed = InvoiceSchema.safeParse(input.value);
  if (!projection || !parsed.success) throw new Error('Subscription paid coverage is incomplete');
  const invoice = parsed.data;
  if (invoice.amount_paid < invoice.amount_due) throw new Error('Subscription invoice is not fully paid');
  const candidates = invoice.lines.data.flatMap(line => {
    if (line.type !== 'subscription' && line.parent?.type !== 'subscription_item_details') return [];
    const subscriptionId = line.subscription ?? line.parent?.subscription_item_details?.subscription;
    if (subscriptionId !== projection.stripeSubscriptionId) throw new Error('Subscription invoice line identity mismatch');
    const price = line.price?.id ?? line.pricing?.price_details.price;
    const plan = price ? input.priceCatalog.priceToPlan.get(price)?.planSlug : undefined;
    return plan && subscriptionCreditAmount(plan) && line.amount >= 0 ? [{ plan, line }] : [];
  });
  if (!candidates.length) return;
  if (candidates.length !== 1) throw new Error('Subscription paid coverage is ambiguous');
  const { plan, line } = candidates[0]!;
  const sub = await input.db.executor.selectFrom('billing_subscriptions').selectAll()
    .where('stripe_subscription_id', '=', projection.stripeSubscriptionId).executeTakeFirst();
  if (!sub) throw new Error('Subscription paid coverage is awaiting projection');
  if (sub.stripe_customer_id !== invoice.customer) throw new Error('Subscription paid coverage identity mismatch');
  await withAccountDeletionOwnerLock(input.db, sub.clerk_user_id, async (trx, admission) => {
    if (!admission.newWorkAllowed) return;
    const paidFrom = new Date(line.period.start * 1000).toISOString(), paidUntil = new Date(line.period.end * 1000).toISOString();
    if (paidUntil <= paidFrom) throw new Error('Subscription paid coverage dates are invalid');
    const record = { invoice_id: invoice.id, subscription_id: sub.stripe_subscription_id, owner_id: sub.clerk_user_id,
      plan_slug: plan, paid_from: paidFrom, paid_until: paidUntil, created_at: input.now.toISOString() };
    await trx.executor.insertInto('ai_subscription_credit_payments').values(record)
      .onConflict(oc => oc.column('invoice_id').doNothing()).execute();
    const stored = await trx.executor.selectFrom('ai_subscription_credit_payments').selectAll().where('invoice_id', '=', invoice.id).executeTakeFirstOrThrow();
    if (stored.subscription_id !== record.subscription_id || stored.owner_id !== record.owner_id || stored.plan_slug !== record.plan_slug
      || stored.paid_from !== paidFrom || stored.paid_until !== paidUntil) throw new Error('Subscription paid coverage conflicts');
    await issueSubscriptionRuntimeCredit({ ...input, db: trx }, sub.stripe_subscription_id);
  }, input.env);
}
