import type { PlatformDB } from './db.js';
import type { SubscriptionCreditCyclesTable } from './subscription-ai-credit-types.js';
import { exactInteger } from './ai-funded-metering-helpers.js';
import { reconcileExpiredPromotionalCredit, MAX_PROMOTIONAL_GRANTS_PER_RUNTIME,
  type FundedAiRuntimeIdentity } from './ai-funded-reservation-sources.js';
import { alignCreditBackedBudget } from './funded-credit-budget.js';

/** Called inside the funded-owner transaction. Revoke a stale installment by
 * expiring its backing, then reissue only legitimate net entitlement. Existing
 * expiry accounting protects active allocations and retires their unused part
 * on release/settlement, so it cannot become spendable again with an old token.
 * Net issuance includes settled usage; it is never the remaining balance. */
export async function reconcileSubscriptionCredit(input: {
  db: PlatformDB; identity: FundedAiRuntimeIdentity; cycle: SubscriptionCreditCyclesTable;
  digest: string; entitled: number; at: string;
}): Promise<{ netIssued: number; grossIssued: number }> {
  const { db, identity, cycle, digest, entitled, at } = input;
  const grants = await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd'])
    .where('owner_id', '=', identity.ownerId).where('kind', '=', 'promotional_grant')
    .where(eb => eb.or([eb('source_reference', '=', `subscription-credit-v1:${digest}`),
      ...(exactInteger(cycle.legacy_offset_microusd) > 0 ? [eb('source_reference', 'in',
        ['matrix-ai-lifetime-starter', 'user-authorized-main-chat-20261008-permanent-5usd'])] : [])]))
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1).execute();
  if (grants.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) throw new Error('Subscription credit history requires reconciliation');
  const grossIssued = grants.reduce((sum, grant) => exactInteger(sum + exactInteger(grant.amount_microusd)), 0);
  const ids = grants.map(grant => grant.entry_id);
  async function net(): Promise<number> {
    if (!ids.length) return 0;
    const expiries = await db.executor.selectFrom('ai_funded_credit_ledger')
      .select(({ fn }) => fn.sum<number>('amount_microusd').as('amount'))
      .where('owner_id', '=', identity.ownerId).where('kind', '=', 'promotional_expiry')
      .where('source_reference', 'in', ids).executeTakeFirstOrThrow();
    const netIssued = exactInteger(grossIssued + exactInteger(expiries.amount ?? 0));
    if (netIssued < 0 || netIssued > grossIssued) throw new Error('Subscription credit expiry invariant violated');
    return netIssued;
  }
  if (entitled < await net()) {
    await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ expires_at: at, updated_at: at })
      .where('owner_id', '=', identity.ownerId).where('machine_id', '=', identity.machineId)
      .where('runtime_slot', '=', identity.runtimeSlot).where('grant_entry_id', 'in', ids)
      .where(eb => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at)])).execute();
  }
  await reconcileExpiredPromotionalCredit(db.executor, identity, at);
  await alignCreditBackedBudget(db, identity, at);
  return { netIssued: await net(), grossIssued };
}
