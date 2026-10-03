import type { PlatformDB } from "./db.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";
import { activePromotionalProtection, eligiblePromotionalCredit, type FundedAiRuntimeIdentity } from "./ai-funded-reservation-sources.js";

type ChatBalance = {
  credit_balance_microusd: unknown;
  promotional_balance_microusd: unknown;
  reserved_microusd: unknown;
};

/** Project Chat eligibility without rewriting the shared speech/Chat ledger.
 * Unknown historical holds remain reserved; only explicit speech allocations
 * can be removed from Chat's hold total. Expired protection stays unavailable. */
export async function projectChatBalance<T extends ChatBalance>(
  executor: PlatformDB["executor"], identity: FundedAiRuntimeIdentity, balance: T, checkedAt: string,
): Promise<T> {
  const grants = await executor.selectFrom("ai_funded_promotional_grant_balances")
    .select(["grant_entry_id", "remaining_microusd", "expires_at"])
    .where("owner_id", "=", identity.ownerId).where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot).where("remaining_microusd", ">", 0)
    .limit(65).execute();
  if (grants.length > 64) throw new Error("Funded AI promotional grant limit invariant violated");
  const protection = await activePromotionalProtection(executor, identity);
  let excludedCredit = 0;
  let excludedHolds = 0;
  for (const grant of grants) {
    const remaining = exactInteger(grant.remaining_microusd);
    const held = protection.get(grant.grant_entry_id) ?? 0;
    const eligible = eligiblePromotionalCredit(grant, held, checkedAt);
    if (grant.grant_entry_id.startsWith("speech-monthly:")) {
      excludedCredit = exactInteger(excludedCredit + remaining);
      excludedHolds = exactInteger(excludedHolds + held);
    } else {
      excludedCredit = exactInteger(excludedCredit + remaining - held - eligible);
    }
  }
  const promotional = exactInteger(balance.promotional_balance_microusd) - excludedCredit;
  const credit = exactInteger(balance.credit_balance_microusd) - excludedCredit;
  const reserved = exactInteger(balance.reserved_microusd) - excludedHolds;
  if (promotional < 0 || credit < 0 || reserved < 0) {
    throw new Error("Funded AI Chat funding projection invariant violated");
  }
  return { ...balance, promotional_balance_microusd: promotional,
    credit_balance_microusd: credit, reserved_microusd: reserved };
}
