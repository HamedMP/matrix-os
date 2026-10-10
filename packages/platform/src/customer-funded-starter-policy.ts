import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { FundedAiGlobalPolicySchema, IsoTimestampSchema } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import { AccountDeletionAdmissionError, withAccountDeletionOwnerLock } from './account-deletion/admission.js';
import { createAiFundedPolicyRepository } from './ai-funded-policy-repository.js';
import { parseModels } from './ai-funded-metering-helpers.js';

const ORDINARY_MODELS = ['anthropic/claude-sonnet-5', '@cf/zai-org/glm-5.3-flash'];
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
  options: { now: string; env?: NodeJS.ProcessEnv },
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
    if (!machine || machine.clerk_user_id !== identity.clerk_user_id || machine.runtime_slot !== 'primary'
      || machine.provisioning_class !== 'customer' || machine.status !== 'running'
      || machine.activation_state !== 'authorized' || machine.deleted_at !== null) return false;
    const global = await trx.executor.selectFrom('ai_funded_global_policy').selectAll()
      .where('policy_id', '=', 'default').forUpdate().executeTakeFirstOrThrow();
    if (!global.enabled) return false;
    const policy = FundedAiGlobalPolicySchema.parse({ enabled: global.enabled, revision: global.revision,
      allowedModelIds: JSON.parse(global.allowed_model_ids) as unknown, updatedAt: global.updated_at });
    const models = ORDINARY_MODELS.filter(model => policy.allowedModelIds.includes(model));
    if (models.length === 0) return false;
    const existing = await trx.executor.selectFrom('ai_funded_runtime_policies').selectAll()
      .where('machine_id', '=', machineId).forUpdate().executeTakeFirst();
    if (existing && (existing.owner_id !== machine.clerk_user_id || existing.runtime_slot !== 'primary')) {
      throw new Error('Funded starter policy identity mismatch');
    }
    if (existing && (!existing.enabled || (existing.expires_at !== null && !(Date.parse(existing.expires_at) > atMs))
      || !models.some(model => parseModels(existing.allowed_model_ids).includes(model)))) return false;
    const inserted = existing ? undefined : await trx.executor.insertInto('ai_funded_runtime_policies').values({
      machine_id: machineId, owner_id: machine.clerk_user_id, runtime_slot: 'primary', enabled: true,
      allowed_model_ids: JSON.stringify(models), monthly_budget_microusd: STARTER_MICROUSD,
      expires_at: null, revision: 1, next_issue_at: '1970-01-01T00:00:00.000Z', created_at: at, updated_at: at,
    }).onConflict(conflict => conflict.column('machine_id').doNothing()).returning('machine_id').executeTakeFirst();
    const month = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), 1)).toISOString();
    await trx.executor.insertInto('ai_funded_runtime_balances').values({
      machine_id: machineId, owner_id: machine.clerk_user_id, runtime_slot: 'primary',
      credit_balance_microusd: 0, promotional_balance_microusd: 0, addon_balance_microusd: 0,
      reserved_microusd: 0, funding_shortfall_microusd: 0, month_period_start: month,
      month_spent_microusd: 0, month_reserved_microusd: 0, updated_at: at,
    }).onConflict(conflict => conflict.column('machine_id').doNothing()).execute();
    const balance = await trx.executor.selectFrom('ai_funded_runtime_balances')
      .select(['owner_id', 'runtime_slot']).where('machine_id', '=', machineId).executeTakeFirstOrThrow();
    if (balance.owner_id !== machine.clerk_user_id || balance.runtime_slot !== 'primary') {
      throw new Error('Funded starter balance identity mismatch');
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
      credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET ?? '', now: () => new Date(at) });
    await repo.grantCreditInTransaction(trx, { entryId,
      identity: { ownerId: machine.clerk_user_id, machineId, runtimeSlot: 'primary' },
      kind: 'promotional_grant', amountMicrousd: STARTER_MICROUSD,
      sourceReference: STARTER_SOURCE, expiresAt: null }, at);
    return true;
  });
}
