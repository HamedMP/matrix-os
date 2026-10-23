import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { FundedAiGlobalPolicySchema, IsoTimestampSchema, MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import type { AiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { subscriptionCreditAmount } from './subscription-ai-credit-types.js';
import { subscriptionCreditCycle } from './subscription-ai-credit-cycle.js';
import type { PlatformDB } from './db.js';
import { AccountDeletionAdmissionError, withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { createAiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { parseModels } from './ai-funded-metering-helpers.js';
import { issueConfiguredSubscriptionAiCredit, loadSubscriptionAiCreditPolicy } from './subscription-ai-credit-policy.js';

const ORDINARY_MODELS = ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS];
const STARTER_MICROUSD = 5_000_000;
const STARTER_SOURCE = 'matrix-ai-lifetime-starter';
// Compatibility with the permanent starter entitlement issued before onboarding
// was integrated. These source identifiers contain no customer identity.
const LEGACY_SOURCE = 'user-authorized-main-chat-20261008-permanent-5usd';
const LEGACY_PREFIX = 'manual-main-chat-20261008-permanent-5usd';
const enabled = (env: NodeJS.ProcessEnv) => env.MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED === 'true'
  && env.MATRIX_FUNDED_AI_RUNTIME_ENABLED === 'true';

/** Activation callers acquire these BEFORE intent/machine writes. Nested calls
 * reuse the same connection and transaction; locks survive through activation. */
export async function lockCustomerFundedStarterActivation(
  db: PlatformDB, ownerId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!enabled(env)) return;
  if (!db.executor.isTransaction) throw new Error('Funded activation requires a transaction');
  await withAccountDeletionOwnerLock(db, ownerId, async (trx, admission) => {
    if (!admission.newWorkAllowed) throw new AccountDeletionAdmissionError();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${ownerId}`}, 0))`.execute(trx.executor);
  }, env);
}

/** Creates only missing policy/entitlement, never refills consumed credit or
 * changes existing policy, grant provenance, reservations or token epochs. */
export async function initializeCustomerFundedStarterPolicy(
  db: PlatformDB, machineId: string,
  options: { now: string; env?: NodeJS.ProcessEnv; repository?: Pick<AiFundedPolicyRepository, 'grantCreditInTransaction'> },
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!enabled(env)) return false;
  const at = IsoTimestampSchema.parse(options.now);
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error('Invalid funded starter activation time');
  return db.transaction(async trx => {
    const identity = await trx.executor.selectFrom('user_machines').select('clerk_user_id')
      .where('machine_id', '=', machineId).executeTakeFirst();
    if (!identity) return false;
    await lockCustomerFundedStarterActivation(trx, identity.clerk_user_id, env);
    const machine = await trx.executor.selectFrom('user_machines')
      .select(['clerk_user_id', 'runtime_slot', 'provisioning_class', 'status', 'activation_state', 'deleted_at'])
      .where('machine_id', '=', machineId).forUpdate().executeTakeFirst();
    if (!machine || machine.clerk_user_id !== identity.clerk_user_id
      || machine.provisioning_class !== 'customer' || machine.status !== 'running'
      || machine.activation_state !== 'authorized' || machine.deleted_at !== null) return false;
    const subscriptionEnabled = loadSubscriptionAiCreditPolicy(env).enabled;
    if (subscriptionEnabled) {
      // No automatic policy for free/trial/preview computers or unverified historical billing.
      const subscriptions = await trx.executor.selectFrom('billing_subscriptions').select(['stripe_subscription_id', 'plan_slug'])
        .where('clerk_user_id', '=', machine.clerk_user_id).where('runtime_slot', '=', machine.runtime_slot)
        .where('status', 'in', ['active', 'canceled']).where('current_period_end', '>', at).limit(2).execute();
      if (subscriptions.length !== 1 || !subscriptionCreditAmount(subscriptions[0]!.plan_slug)) return false;
      const subscriptionId = subscriptions[0]!.stripe_subscription_id;
      const terms = await trx.executor.selectFrom('ai_subscription_credit_terms').select('anchor_at')
        .where('subscription_id', '=', subscriptionId).where('owner_id', '=', machine.clerk_user_id)
        .where('runtime_slot', '=', machine.runtime_slot).executeTakeFirst();
      if (!terms || !subscriptionCreditCycle(terms.anchor_at, new Date(at))) return false;
      const payments = await trx.executor.selectFrom('ai_subscription_credit_payments').select('plan_slug')
        .where('subscription_id', '=', subscriptionId).where('owner_id', '=', machine.clerk_user_id)
        .where('paid_from', '<=', at).where('paid_until', '>', at).limit(33).execute();
      if (payments.length > 32 || !payments.some(payment => subscriptionCreditAmount(payment.plan_slug))) return false;
    } else if (machine.runtime_slot !== 'primary') return false;
    const global = await trx.executor.selectFrom('ai_funded_global_policy').selectAll()
      .where('policy_id', '=', 'default').forShare().executeTakeFirstOrThrow();
    if (!global.enabled) return false;
    const policy = FundedAiGlobalPolicySchema.parse({ enabled: global.enabled, revision: global.revision,
      allowedModelIds: JSON.parse(global.allowed_model_ids) as unknown, updatedAt: global.updated_at });
    const models = ORDINARY_MODELS.filter(model => policy.allowedModelIds.includes(model));
    if (models.length === 0) return false;
    const existing = await trx.executor.selectFrom('ai_funded_runtime_policies').selectAll()
      .where('machine_id', '=', machineId).forUpdate().executeTakeFirst();
    if (existing && (existing.owner_id !== machine.clerk_user_id || existing.runtime_slot !== machine.runtime_slot)) {
      throw new Error('Funded starter policy identity mismatch');
    }
    if (existing && (!existing.enabled || (existing.expires_at !== null && !(Date.parse(existing.expires_at) > atMs))
      || !models.some(model => parseModels(existing.allowed_model_ids).includes(model)))) return false;
    const inserted = existing ? undefined : await trx.executor.insertInto('ai_funded_runtime_policies').values({
      machine_id: machineId, owner_id: machine.clerk_user_id, runtime_slot: machine.runtime_slot, enabled: true,
      allowed_model_ids: JSON.stringify(models), monthly_budget_microusd: STARTER_MICROUSD,
      budget_mode: 'credit_backed',
      expires_at: null, revision: 1, next_issue_at: '1970-01-01T00:00:00.000Z', created_at: at, updated_at: at,
    }).onConflict(conflict => conflict.column('machine_id').doNothing()).returning('machine_id').executeTakeFirst();
    const month = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), 1)).toISOString();
    await trx.executor.insertInto('ai_funded_runtime_balances').values({
      machine_id: machineId, owner_id: machine.clerk_user_id, runtime_slot: machine.runtime_slot,
      credit_balance_microusd: 0, promotional_balance_microusd: 0, addon_balance_microusd: 0,
      reserved_microusd: 0, funding_shortfall_microusd: 0, month_period_start: month,
      month_spent_microusd: 0, month_reserved_microusd: 0, updated_at: at,
    }).onConflict(conflict => conflict.column('machine_id').doNothing()).execute();
    const balance = await trx.executor.selectFrom('ai_funded_runtime_balances')
      .select(['owner_id', 'runtime_slot']).where('machine_id', '=', machineId).executeTakeFirstOrThrow();
    if (balance.owner_id !== machine.clerk_user_id || balance.runtime_slot !== machine.runtime_slot) {
      throw new Error('Funded starter balance identity mismatch');
    }
    if (subscriptionEnabled) {
      const repo = options.repository ?? createAiFundedPolicyRepository({ db: trx,
        credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET ?? '', subscriptionCreditEnv: env });
      await issueConfiguredSubscriptionAiCredit({ db: trx, repository: repo,
        identity: { ownerId: machine.clerk_user_id, machineId, runtimeSlot: machine.runtime_slot }, env, now: new Date(at) });
      return Boolean(inserted);
    }
    const entryId = `starter-lifetime:${createHash('sha256').update(machine.clerk_user_id).digest('hex')}`;
    const prior = await trx.executor.selectFrom('ai_funded_credit_ledger')
      .select(['entry_id', 'kind', 'amount_microusd', 'expires_at', 'source_reference'])
      .where('owner_id', '=', machine.clerk_user_id)
      .where(eb => eb.or([eb('source_reference', '=', LEGACY_SOURCE), eb('entry_id', '=', entryId)]))
      .limit(2).execute();
    if (prior.length > 1 || prior.some(row => row.kind !== 'promotional_grant'
      || Number(row.amount_microusd) !== STARTER_MICROUSD || row.expires_at !== null
      || (row.entry_id === entryId ? row.source_reference !== STARTER_SOURCE
        : row.source_reference !== LEGACY_SOURCE || !row.entry_id.startsWith(LEGACY_PREFIX)))) {
      throw new Error('Conflicting permanent starter entitlement');
    }
    if (prior.length === 1) return Boolean(inserted);
    const repo = createAiFundedPolicyRepository({ db: trx,
      credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET ?? '' });
    await repo.grantCreditInTransaction(trx, { entryId,
      identity: { ownerId: machine.clerk_user_id, machineId, runtimeSlot: machine.runtime_slot },
      kind: 'promotional_grant', amountMicrousd: STARTER_MICROUSD,
      sourceReference: STARTER_SOURCE, expiresAt: null }, at);
    return true;
  });
}
