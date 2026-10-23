import type { FundedAiIdentity } from '@matrix-os/contracts';
import type { PlatformDB } from './db.js';
import { exactInteger, utcMonthStart } from './ai-funded-metering-helpers.js';

/** Runs after a real grant, under its machine lock and transaction.
 * Fixed operator ceilings are preserved; this never creates credit or holds. */
export async function alignCreditBackedBudget(db: PlatformDB, identity: FundedAiIdentity, at: string): Promise<void> {
  if (!db.executor.isTransaction) throw new Error('Credit budget alignment requires a transaction');
  const row = await db.executor.selectFrom('ai_funded_runtime_policies as policy')
    .innerJoin('ai_funded_runtime_balances as balance', join => join
      .onRef('balance.machine_id', '=', 'policy.machine_id')
      .onRef('balance.owner_id', '=', 'policy.owner_id')
      .onRef('balance.runtime_slot', '=', 'policy.runtime_slot'))
    .select(['policy.budget_mode', 'policy.monthly_budget_microusd', 'policy.revision',
      'balance.credit_balance_microusd', 'balance.funding_shortfall_microusd',
      'balance.month_spent_microusd', 'balance.month_period_start'])
    .where('policy.machine_id', '=', identity.machineId).where('policy.owner_id', '=', identity.ownerId)
    .where('policy.runtime_slot', '=', identity.runtimeSlot).forUpdate('policy').executeTakeFirst();
  if (!row || row.budget_mode !== 'credit_backed') return;
  const spent = row.month_period_start === utcMonthStart(new Date(at)) ? exactInteger(row.month_spent_microusd) : 0;
  const netCredit = Math.max(0, exactInteger(row.credit_balance_microusd) - exactInteger(row.funding_shortfall_microusd));
  const budget = exactInteger(spent + netCredit);
  if (budget === exactInteger(row.monthly_budget_microusd)) return;
  if (row.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Funded policy revision limit reached');
  const updated = await db.executor.updateTable('ai_funded_runtime_policies').set({
    monthly_budget_microusd: budget, revision: row.revision + 1, updated_at: at,
  }).where('machine_id', '=', identity.machineId).where('owner_id', '=', identity.ownerId)
    .where('runtime_slot', '=', identity.runtimeSlot).where('budget_mode', '=', 'credit_backed')
    .where('revision', '=', row.revision).returning('machine_id').executeTakeFirst();
  if (!updated) throw new Error('Funded credit budget changed concurrently');
}
