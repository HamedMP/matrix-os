import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { sql } from 'kysely';
import { parseModels } from './ai-funded-metering-helpers.js';
import type { PlatformDB } from './db.js';
import { FREE_MANAGED_MODEL_ID } from './free-tier/funded-policy.js';
import { freeMetalMachine } from './free-tier/free-runtime.js';

/** Ordinary models are shared customer entitlement. Specialized routes such as
 * Jev and funded-native Opus retain their explicit per-runtime authorization. */
export function ordinaryCustomerModelIds(globalModels: readonly string[]): string[] {
  return ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS]
    .filter(model => globalModels.includes(model));
}

/** Free metal runtimes get the managed default model only (spec 2691 D2, ENG-520 P7). */
export function freeRuntimeModelIds(globalModels: readonly string[]): string[] {
  return [FREE_MANAGED_MODEL_ID].filter(model => globalModels.includes(model));
}

/** Restore normal model access only for policies initialized with the free default.
 * The billing owner lock is already held by the entitlement writer. */
export async function restorePaidModelDefaults(db: PlatformDB, ownerId: string, updatedAt: string): Promise<void> {
  const pending = await db.executor.selectFrom('ai_funded_runtime_policies').select('machine_id')
    .where('owner_id', '=', ownerId).where('uses_free_model_default', '=', true).executeTakeFirst();
  if (!pending) return;
  const global = await db.executor.selectFrom('ai_funded_global_policy').select('allowed_model_ids')
    .where('policy_id', '=', 'default').forShare().executeTakeFirstOrThrow();
  const models = ordinaryCustomerModelIds(parseModels(global.allowed_model_ids));
  if (models.length === 0) return;
  await db.executor.updateTable('ai_funded_runtime_policies').set({
    allowed_model_ids: JSON.stringify(models), uses_free_model_default: false,
    revision: sql<number>`revision + 1`, updated_at: updatedAt,
  }).where('owner_id', '=', ownerId).where('uses_free_model_default', '=', true)
    .where('machine_id', 'in', db.executor.selectFrom('user_machines').select('machine_id')
      .where('clerk_user_id', '=', ownerId).where('deleted_at', 'is', null))
    .execute();
}

/** Run inside the global-policy transaction: a failed alignment must roll back
 * the global revision too. Use a set-based write and return only one aggregate,
 * so fleet size does not produce an unbounded in-process inventory. */
export async function alignCustomerOrdinaryModels(
  db: PlatformDB, globalModels: readonly string[], updatedAt: string,
): Promise<void> {
  if (!db.executor.isTransaction) throw new Error('Customer model alignment requires a transaction');
  const ordinary = ordinaryCustomerModelIds(globalModels);
  if (ordinary.length === 0) return;
  const modelsJson = JSON.stringify(ordinary);
  const managedJson = JSON.stringify(MANAGED_WORKERS_AI_MODEL_IDS);
  const result = await sql<{ invalid: boolean; overflow: boolean }>`with policies as materialized (
    select runtime.machine_id, runtime.allowed_model_ids::jsonb as models
    from ai_funded_runtime_policies runtime join user_machines machine
      on machine.machine_id = runtime.machine_id
      and machine.clerk_user_id = runtime.owner_id and machine.runtime_slot = runtime.runtime_slot
    where machine.provisioning_class = 'customer' and machine.activation_state = 'authorized'
      and machine.deleted_at is null
      -- A free metal runtime keeps only the managed default model (ENG-520 P7).
      and not ${freeMetalMachine('machine.machine_id')}
    for update of runtime
  ), invalid as (
    select machine_id from policies
    where jsonb_typeof(models) <> 'array' or exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(models) = 'array' then models else '[]'::jsonb end
      ) element(value)
      having count(*) > 64 or count(distinct value) <> count(*) or bool_or(
        jsonb_typeof(value) <> 'string' or length(value #>> '{}') not between 3 and 200
        or not ((value #>> '{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
          or ${managedJson}::jsonb @> jsonb_build_array(value))
      )
    )
  ), aligned as (
    update ai_funded_runtime_policies runtime set
      allowed_model_ids = (
        select jsonb_agg(item.value order by item.position)::text from (
          select value, min(position) as position
          from jsonb_array_elements_text(policies.models || ${modelsJson}::jsonb)
            with ordinality as models(value, position)
          group by value
        ) item
      ),
      revision = runtime.revision + 1, updated_at = ${updatedAt}
    from policies
    where runtime.machine_id = policies.machine_id
      and not exists (select 1 from invalid)
      and not policies.models @> ${modelsJson}::jsonb
    returning jsonb_array_length(allowed_model_ids::jsonb) as model_count
  ) select exists(select 1 from invalid) as invalid,
    coalesce(bool_or(model_count > 64), false) as overflow from aligned`.execute(db.executor);
  // Validate the original JSON before text extraction or deduplication can heal
  // corrupt policies. Throw inside the transaction to roll back publication too.
  if (result.rows[0]?.invalid) throw new Error('Customer model alignment encountered an invalid policy');
  if (result.rows[0]?.overflow) throw new Error('Customer model alignment exceeds the policy model limit');
}
