import type { PlatformDB } from "./db.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";
import { activePromotionalProtection, MAX_PROMOTIONAL_GRANTS_PER_RUNTIME,
  type FundedAiRuntimeIdentity } from "./ai-funded-reservation-sources.js";

/** Read under the caller's repeatable-read, read-only transaction. Project the
 * same unprotected expiry debit as reconciliation, without locks or writes. */
export async function projectExpiredPromotionalCredit<T extends {
  credit_balance_microusd: unknown; promotional_balance_microusd: unknown;
}>(executor: PlatformDB["executor"], identity: FundedAiRuntimeIdentity, balance: T, checkedAt: string): Promise<T> {
  const expired = await executor.selectFrom("ai_funded_promotional_grant_balances")
    .select(["grant_entry_id", "remaining_microusd"])
    .where("owner_id", "=", identity.ownerId)
    .where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("remaining_microusd", ">", 0)
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", checkedAt)
    .orderBy("expires_at").orderBy("created_at").orderBy("grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1).execute();
  if (expired.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) throw new Error("Funded AI promotional grant limit invariant violated");
  const protection = await activePromotionalProtection(executor, identity);
  let retired = 0;
  for (const grant of expired) {
    const remaining = exactInteger(grant.remaining_microusd);
    const held = protection.get(grant.grant_entry_id) ?? 0;
    if (held < 0 || held > remaining) throw new Error("Funded AI promotional allocation invariant violated");
    retired = exactInteger(retired + (remaining - held));
  }
  const credit = exactInteger(balance.credit_balance_microusd) - retired;
  const promotional = exactInteger(balance.promotional_balance_microusd) - retired;
  if (credit < 0 || promotional < 0) throw new Error("Funded AI promotional expiry balance invariant violated");
  return { ...balance, credit_balance_microusd: credit, promotional_balance_microusd: promotional };
}
