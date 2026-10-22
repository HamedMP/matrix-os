import { reconcileSubscriptionCredit } from './subscription-ai-credit-reconciliation.js';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod/v4';
import { FundedAiIdentitySchema, IsoTimestampSchema } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import type { AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { exactInteger, intersectModels, parseModels } from './ai-funded-metering-helpers.js';
import { subscriptionCreditCycle } from './subscription-ai-credit-cycle.js';
import { SUBSCRIPTION_CREDIT_AMOUNTS, subscriptionCreditAmount, type SubscriptionCreditCyclesTable } from './subscription-ai-credit-types.js';

export function loadSubscriptionAiCreditPolicy(env: NodeJS.ProcessEnv) {
  if (env.MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED !== 'true') return { enabled: false } as const;
  if (env.MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON !== undefined) throw new Error('Legacy subscription AI credit configuration must be reviewed');
  return { enabled: true, amountsMicrousd: SUBSCRIPTION_CREDIT_AMOUNTS } as const;
}

/** Only shorten unspent grant expiry; immutable ledger, entitlement and active
 * reservation allocations remain intact, including a delayed cancellation. */
export async function shortenSubscriptionCreditCycle(db: PlatformDB, row: SubscriptionCreditCyclesTable, end: string, at: string): Promise<void> {
  if (end >= row.cycle_end) return;
  const digest = createHash('sha256').update(`${row.owner_id}\0${row.runtime_slot}\0${row.cycle_start}`).digest('hex');
  const grants = db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
    .where('owner_id', '=', row.owner_id).where('kind', '=', 'promotional_grant')
    .where(eb => eb.or([eb('source_reference', '=', `subscription-credit-v1:${digest}`),
      ...(exactInteger(row.legacy_offset_microusd) > 0 ? [eb('source_reference', 'in',
        ['matrix-ai-lifetime-starter', 'user-authorized-main-chat-20261008-permanent-5usd'])] : [])]));
  await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ expires_at: end, updated_at: at })
    .where('owner_id', '=', row.owner_id).where('runtime_slot', '=', row.runtime_slot)
    .where('grant_entry_id', 'in', grants).where('expires_at', '>', end).execute();
  // A cancellation predating this cycle revokes its remainder but does not
  // invent an invalid/negative audit interval or reset its issued entitlement.
  if (end > row.cycle_start) await db.executor.updateTable('ai_subscription_credit_cycles')
    .set({ cycle_end: end, updated_at: at }).where('owner_id', '=', row.owner_id)
    .where('runtime_slot', '=', row.runtime_slot).where('cycle_start', '=', row.cycle_start)
    .where('cycle_end', '=', row.cycle_end).execute();
}

/** Exact current installment only; no expired backfill or annual lump sum.
 * Authority is current billing plus recorded, signed paid invoice coverage. */
export async function issueConfiguredSubscriptionAiCredit(input: {
  db: PlatformDB;
  repository: Pick<AiFundedPolicyRepository, 'grantCreditInTransaction'>;
  identity: z.input<typeof FundedAiIdentitySchema>;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<'disabled' | 'ineligible' | 'accepted'> {
  if (!loadSubscriptionAiCreditPolicy(input.env).enabled) return 'disabled';
  const identity = FundedAiIdentitySchema.parse(input.identity);
  const at = IsoTimestampSchema.parse(input.now.toISOString());
  if (identity.runtimeSlot !== 'primary') return 'ineligible';
  await input.db.ready;
  return withAccountDeletionOwnerLock(input.db, identity.ownerId, async (trx, admission) => {
    if (!admission.newWorkAllowed) return 'ineligible';
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
    const machine = await trx.executor.selectFrom('user_machines').select([
      'clerk_user_id', 'runtime_slot', 'status', 'activation_state', 'provisioning_class', 'deleted_at',
    ]).where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
      || machine.status !== 'running' || machine.activation_state !== 'authorized'
      || machine.provisioning_class !== 'customer' || machine.deleted_at !== null) return 'ineligible';
    const runtime = await trx.executor.selectFrom('ai_funded_runtime_policies').select([
      'owner_id', 'runtime_slot', 'enabled', 'expires_at', 'allowed_model_ids',
    ]).where('machine_id', '=', identity.machineId).forUpdate().executeTakeFirst();
    const global = await trx.executor.selectFrom('ai_funded_global_policy').select(['enabled', 'allowed_model_ids'])
      .where('policy_id', '=', 'default').forUpdate().executeTakeFirstOrThrow();
    if (!runtime?.enabled || !global.enabled || runtime.owner_id !== identity.ownerId
      || runtime.runtime_slot !== identity.runtimeSlot || runtime.expires_at !== null && runtime.expires_at <= at
      || intersectModels(parseModels(global.allowed_model_ids), parseModels(runtime.allowed_model_ids)).length === 0) return 'ineligible';
    const subscriptions = await trx.executor.selectFrom('billing_subscriptions').select([
      'stripe_subscription_id', 'plan_slug', 'current_period_end',
    ]).where('clerk_user_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot)
      .where('status', 'in', ['active', 'canceled']).where('current_period_end', '>', at).limit(2).forUpdate().execute();
    if (subscriptions.length !== 1) return 'ineligible';
    const subscription = subscriptions[0]!;
    const currentAmount = subscriptionCreditAmount(subscription.plan_slug);
    const terms = await trx.executor.selectFrom('ai_subscription_credit_terms').selectAll()
      .where('subscription_id', '=', subscription.stripe_subscription_id).where('owner_id', '=', identity.ownerId)
      .where('runtime_slot', '=', identity.runtimeSlot).forUpdate().executeTakeFirst();
    if (!currentAmount || !terms) return 'ineligible';
    const cycle = subscriptionCreditCycle(terms.anchor_at, input.now);
    if (!cycle) return 'ineligible';
    const payments = await trx.executor.selectFrom('ai_subscription_credit_payments').select(['plan_slug', 'paid_until'])
      .where('subscription_id', '=', subscription.stripe_subscription_id).where('owner_id', '=', identity.ownerId)
      .where('paid_from', '<=', at).where('paid_until', '>', at).limit(33).execute();
    if (!payments.length || payments.length > 32) return 'ineligible';
    const paidAmount = Math.max(...payments.map(p => subscriptionCreditAmount(p.plan_slug) ?? 0));
    const goal = terms.floor_cycle_start === cycle.start ? Math.max(currentAmount, exactInteger(terms.floor_microusd)) : currentAmount;
    const entitled = Math.min(goal, paidAmount);
    if (entitled <= 0) return 'ineligible';
    const paidUntil = payments.filter(p => (subscriptionCreditAmount(p.plan_slug) ?? 0) >= entitled)
      .map(p => p.paid_until).sort().at(-1)!;
    const end = [cycle.end, paidUntil, subscription.current_period_end!].sort()[0]!;
    const overlap = await trx.executor.selectFrom('ai_subscription_credit_cycles').select('subscription_id')
      .where('owner_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot)
      .where('cycle_start', '<', end).where('cycle_end', '>', cycle.start)
      .where(eb => eb.or([eb('cycle_start', '!=', cycle.start), eb('subscription_id', '!=', subscription.stripe_subscription_id)]))
      .limit(1).executeTakeFirst();
    if (overlap) return 'ineligible';
    let row = await trx.executor.selectFrom('ai_subscription_credit_cycles').selectAll()
      .where('owner_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot)
      .where('cycle_start', '=', cycle.start).forUpdate().executeTakeFirst();
    if (!row) {
      const prior = await trx.executor.selectFrom('ai_subscription_credit_cycles').select('cycle_start')
        .where('owner_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot).limit(1).executeTakeFirst();
      let legacyOffset = 0;
      if (!prior) {
        const legacy = await trx.executor.selectFrom('ai_funded_credit_ledger').selectAll().where('owner_id', '=', identity.ownerId)
          .where('source_reference', 'in', ['matrix-ai-lifetime-starter', 'user-authorized-main-chat-20261008-permanent-5usd']).limit(2).execute();
        if (legacy.length > 1) throw new Error('Ambiguous starter credit entitlement');
        if (legacy[0]) {
          const grant = legacy[0];
          const expectedId = `starter-lifetime:${createHash('sha256').update(identity.ownerId).digest('hex')}`;
          if (grant.kind !== 'promotional_grant' || exactInteger(grant.amount_microusd) !== 5_000_000 || grant.expires_at !== null
            || (grant.source_reference === 'matrix-ai-lifetime-starter' ? grant.entry_id !== expectedId
              : !grant.entry_id.startsWith('manual-main-chat-20261008-permanent-5usd'))) throw new Error('Invalid starter credit entitlement');
          const adopted = await trx.executor.updateTable('ai_funded_promotional_grant_balances').set({ expires_at: end, updated_at: at })
            .where('grant_entry_id', '=', grant.entry_id).where('owner_id', '=', identity.ownerId)
            .where('machine_id', '=', identity.machineId).where('runtime_slot', '=', identity.runtimeSlot)
            .where('expires_at', 'is', null).returning('grant_entry_id').executeTakeFirst();
          if (!adopted) throw new Error('Starter credit location requires reconciliation');
          legacyOffset = 5_000_000;
        }
      }
      row = await trx.executor.insertInto('ai_subscription_credit_cycles').values({
        owner_id: identity.ownerId, runtime_slot: identity.runtimeSlot, cycle_start: cycle.start, cycle_end: end,
        subscription_id: subscription.stripe_subscription_id, entitlement_microusd: legacyOffset,
        legacy_offset_microusd: legacyOffset, updated_at: at,
      }).onConflict(oc => oc.columns(['owner_id', 'runtime_slot', 'cycle_start']).doNothing()).returningAll().executeTakeFirstOrThrow();
    }
    if (row.subscription_id === subscription.stripe_subscription_id && row.cycle_end > end) {
      await shortenSubscriptionCreditCycle(trx, row, end, at); row = { ...row, cycle_end: end };
    }
    if (row.subscription_id !== subscription.stripe_subscription_id || row.cycle_end !== end) throw new Error('Subscription credit cycle requires reconciliation');
    const previous = exactInteger(row.entitlement_microusd);
    const digest = createHash('sha256').update(`${identity.ownerId}\0${identity.runtimeSlot}\0${cycle.start}`).digest('hex');
    const { netIssued, grossIssued } = await reconcileSubscriptionCredit({ db: trx, identity, cycle: row, digest, entitled, at });
    if (entitled > netIssued) await input.repository.grantCreditInTransaction(trx, { identity,
      entryId: `subscription-credit:${digest}:upto:${entitled}:issued:${grossIssued}`, kind: 'promotional_grant',
      amountMicrousd: entitled - netIssued, sourceReference: `subscription-credit-v1:${digest}`, expiresAt: end,
    }, at);
    const next = Math.max(netIssued, entitled);
    if (next !== previous) {
      const updated = await trx.executor.updateTable('ai_subscription_credit_cycles').set({ entitlement_microusd: next, updated_at: at })
        .where('owner_id', '=', identity.ownerId).where('runtime_slot', '=', identity.runtimeSlot).where('cycle_start', '=', cycle.start)
        .where('entitlement_microusd', '=', previous).returning('cycle_start').executeTakeFirst();
      if (!updated) throw new Error('Subscription credit cycle changed concurrently');
    }
    return 'accepted';
  }, input.env);
}
