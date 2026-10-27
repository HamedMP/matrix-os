import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { sql } from 'kysely';
import type { PlatformDB } from './db.js';

/** Ordinary models are shared customer entitlement. Specialized routes such as
 * Jev and funded-native Opus retain their explicit per-runtime authorization. */
export function ordinaryCustomerModelIds(globalModels: readonly string[]): string[] {
  return ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS]
    .filter(model => globalModels.includes(model));
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
  const result = await sql<{ overflow: boolean }>`with aligned as (
    update ai_funded_runtime_policies runtime set
      allowed_model_ids = (
        select jsonb_agg(item.value order by item.position)::text from (
          select value, min(position) as position
          from jsonb_array_elements_text(runtime.allowed_model_ids::jsonb || ${modelsJson}::jsonb)
            with ordinality as models(value, position)
          group by value
        ) item
      ),
      revision = runtime.revision + 1, updated_at = ${updatedAt}
    from user_machines machine
    where machine.machine_id = runtime.machine_id
      and machine.clerk_user_id = runtime.owner_id and machine.runtime_slot = runtime.runtime_slot
      and machine.provisioning_class = 'customer' and machine.activation_state = 'authorized'
      and machine.deleted_at is null
      and not runtime.allowed_model_ids::jsonb @> ${modelsJson}::jsonb
    returning jsonb_array_length(allowed_model_ids::jsonb) as model_count
  ) select coalesce(bool_or(model_count > 64), false) as overflow from aligned`.execute(db.executor);
  // No partial global rollout when a persisted policy cannot fit the existing
  // contract. All writes above remain uncommitted until this check succeeds.
  if (result.rows[0]?.overflow) throw new Error('Customer model alignment exceeds the policy model limit');
}
