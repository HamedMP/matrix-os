import { createHash } from "node:crypto";
import { sql } from "kysely";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import type { AiFundedRuntimeBalancesTable, PlatformDB } from "./db.js";

const MAX_PROMOTIONAL_GRANTS_PER_RUNTIME = 64;
const ACTIVE_RESERVATION_STATUSES = ["reserved", "starting", "in_flight"] as const;

export interface FundedAiRuntimeIdentity {
  ownerId: string;
  machineId: string;
  runtimeSlot: string;
}

export interface FundedAiReservationBalance {
  promotional_balance_microusd: unknown;
  addon_balance_microusd: unknown;
  reserved_microusd: unknown;
}

function exactInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Funded AI monetary total exceeds safe integer range");
  return parsed;
}

export async function activePromotionalProtection(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
): Promise<Map<string, number>> {
  const allocations = await executor.selectFrom("ai_funded_reservation_promotional_allocations as allocation")
    .innerJoin("ai_funded_usage_reservations as reservation", "reservation.reservation_id", "allocation.reservation_id")
    .select([
      "allocation.grant_entry_id",
      ({ fn }) => fn.sum<number>("allocation.amount_microusd").as("reserved_microusd"),
    ])
    .where("reservation.owner_id", "=", identity.ownerId)
    .where("reservation.machine_id", "=", identity.machineId)
    .where("reservation.runtime_slot", "=", identity.runtimeSlot)
    .where("reservation.status", "in", [...ACTIVE_RESERVATION_STATUSES])
    .groupBy("allocation.grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1)
    .execute();
  if (allocations.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
    throw new Error("Funded AI promotional allocation limit invariant violated");
  }
  // Only explicit per-grant allocations are evidence that an active reservation
  // consumed promotional credit. Legacy NULL source attribution remains unknown.
  return new Map(allocations.map((row) => [row.grant_entry_id, exactInteger(row.reserved_microusd)]));
}

async function activeAddonProtection(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
): Promise<number> {
  const protection = await executor.selectFrom("ai_funded_usage_reservations")
    .select(({ fn }) => fn.sum<number>("addon_reserved_microusd").as("reserved_microusd"))
    .where("owner_id", "=", identity.ownerId)
    .where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("status", "in", [...ACTIVE_RESERVATION_STATUSES])
    .where("addon_reserved_microusd", "is not", null)
    .executeTakeFirstOrThrow();
  return exactInteger(protection.reserved_microusd ?? 0);
}

export async function reserveFundingSources(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
  amountMicrousd: number,
  balance: FundedAiReservationBalance,
  checkedAt: string,
): Promise<{
  promotionalReservedMicrousd: number;
  addonReservedMicrousd: number;
  grantAllocations: Array<{ grantEntryId: string; amountMicrousd: number }>;
}> {
  const protection = await activePromotionalProtection(executor, identity);
  const grants = await executor.selectFrom("ai_funded_promotional_grant_balances")
    .selectAll()
    .where("owner_id", "=", identity.ownerId)
    .where("machine_id", "=", identity.machineId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("remaining_microusd", ">", 0)
    .orderBy(sql<number>`CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END`)
    .orderBy("expires_at").orderBy("created_at").orderBy("grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1)
    .forUpdate().execute();
  if (grants.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
    throw new Error("Funded AI promotional grant limit invariant violated");
  }
  let remaining = amountMicrousd;
  const grantAllocations: Array<{ grantEntryId: string; amountMicrousd: number }> = [];
  for (const grant of grants) {
    if (remaining === 0) break;
    const alreadyAllocated = protection.get(grant.grant_entry_id) ?? 0;
    const unallocated = exactInteger(grant.remaining_microusd) - alreadyAllocated;
    if (unallocated < 0) throw new Error("Funded AI promotional allocation invariant violated");
    if (grant.expires_at !== null && grant.expires_at <= checkedAt) continue;
    const allocation = Math.min(unallocated, remaining);
    if (allocation > 0) {
      grantAllocations.push({ grantEntryId: grant.grant_entry_id, amountMicrousd: allocation });
      remaining -= allocation;
    }
  }
  const promotionalReservedMicrousd = amountMicrousd - remaining;
  const addonReservedMicrousd = remaining;
  // Only explicit add-on attribution is evidence that an active reservation
  // consumed add-on credit. Legacy NULL attribution must not be guessed from
  // the aggregate reserved balance because that can block unrelated funding.
  const existingAddonReserved = await activeAddonProtection(executor, identity);
  if (addonReservedMicrousd > exactInteger(balance.addon_balance_microusd) - existingAddonReserved) {
    throw new Error("Funded AI add-on reservation allocation invariant violated");
  }
  return { promotionalReservedMicrousd, addonReservedMicrousd, grantAllocations };
}

export async function reconcileExpiredPromotionalCredit(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
  checkedAt: string,
): Promise<AiFundedRuntimeBalancesTable> {
  const balance = await executor.selectFrom("ai_funded_runtime_balances").selectAll()
    .where("machine_id", "=", identity.machineId)
    .where("owner_id", "=", identity.ownerId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .forUpdate().executeTakeFirst();
  if (!balance) throw new AiFundedPolicyError("access_disabled");

  const expiredGrants = await executor.selectFrom("ai_funded_promotional_grant_balances")
    .selectAll()
    .where("machine_id", "=", identity.machineId)
    .where("owner_id", "=", identity.ownerId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("remaining_microusd", ">", 0)
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", checkedAt)
    .orderBy("expires_at").orderBy("created_at").orderBy("grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1)
    .forUpdate().execute();
  if (expiredGrants.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
    throw new AiFundedPolicyError("access_disabled");
  }

  const protection = await activePromotionalProtection(executor, identity);
  let totalRetired = 0;
  for (const grant of expiredGrants) {
    const remaining = exactInteger(grant.remaining_microusd);
    const attributedProtection = protection.get(grant.grant_entry_id) ?? 0;
    if (attributedProtection > remaining) {
      throw new Error("Funded AI promotional allocation invariant violated");
    }
    const retiredMicrousd = remaining - attributedProtection;
    if (retiredMicrousd === 0) continue;

    const nextRevision = grant.revision + 1;
    const updated = await executor.updateTable("ai_funded_promotional_grant_balances").set({
      remaining_microusd: remaining - retiredMicrousd,
      updated_at: checkedAt,
      revision: nextRevision,
    }).where("grant_entry_id", "=", grant.grant_entry_id)
      .where("owner_id", "=", identity.ownerId)
      .where("machine_id", "=", identity.machineId)
      .where("runtime_slot", "=", identity.runtimeSlot)
      .where("revision", "=", grant.revision)
      .returning("grant_entry_id").executeTakeFirst();
    if (!updated) {
      const latest = await executor.selectFrom("ai_funded_promotional_grant_balances")
        .select(["remaining_microusd", "revision"])
        .where("grant_entry_id", "=", grant.grant_entry_id)
        .where("owner_id", "=", identity.ownerId)
        .where("machine_id", "=", identity.machineId)
        .where("runtime_slot", "=", identity.runtimeSlot).executeTakeFirst();
      if (latest && latest.revision > grant.revision
        && exactInteger(latest.remaining_microusd) <= remaining - retiredMicrousd) {
        continue;
      }
      throw new Error("Funded AI promotional grant revision invariant violated");
    }

    const auditId = createHash("sha256").update(`${grant.grant_entry_id}:${nextRevision}`).digest("hex");
    const auditEntry = {
      entry_id: `promotion-expiry:${auditId}`,
      owner_id: identity.ownerId,
      machine_id: identity.machineId,
      runtime_slot: identity.runtimeSlot,
      kind: "promotional_expiry",
      amount_microusd: -retiredMicrousd,
      source_reference: grant.grant_entry_id,
      reservation_id: null,
      period_start: null,
      expires_at: null,
      created_at: checkedAt,
    };
    const insertedAudit = await executor.insertInto("ai_funded_credit_ledger").values(auditEntry)
      .onConflict((conflict) => conflict.column("entry_id").doNothing())
      .returning("entry_id").executeTakeFirst();
    if (!insertedAudit) {
      const storedAudit = await executor.selectFrom("ai_funded_credit_ledger")
        .selectAll().where("entry_id", "=", auditEntry.entry_id).executeTakeFirst();
      if (!storedAudit || storedAudit.owner_id !== auditEntry.owner_id
        || storedAudit.machine_id !== auditEntry.machine_id
        || storedAudit.runtime_slot !== auditEntry.runtime_slot
        || storedAudit.kind !== auditEntry.kind
        || exactInteger(storedAudit.amount_microusd) !== auditEntry.amount_microusd
        || storedAudit.source_reference !== auditEntry.source_reference
        || storedAudit.reservation_id !== null || storedAudit.period_start !== null) {
        throw new Error("Funded AI promotional expiry audit invariant violated");
      }
    }
    totalRetired += retiredMicrousd;
  }

  if (totalRetired > 0) {
    const updatedBalance = await executor.updateTable("ai_funded_runtime_balances").set({
      credit_balance_microusd: sql<number>`credit_balance_microusd - ${totalRetired}`,
      promotional_balance_microusd: sql<number>`promotional_balance_microusd - ${totalRetired}`,
      updated_at: checkedAt,
    }).where("machine_id", "=", identity.machineId)
      .where("owner_id", "=", identity.ownerId)
      .where("runtime_slot", "=", identity.runtimeSlot)
      .where(sql<boolean>`credit_balance_microusd >= ${totalRetired}`)
      .where(sql<boolean>`promotional_balance_microusd >= ${totalRetired}`)
      .returningAll().executeTakeFirst();
    if (!updatedBalance) throw new Error("Funded AI promotional balance invariant violated");
  }
  return executor.selectFrom("ai_funded_runtime_balances").selectAll()
    .where("machine_id", "=", identity.machineId)
    .where("owner_id", "=", identity.ownerId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .executeTakeFirstOrThrow();
}

export async function debitPromotionalGrants(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
  amountMicrousd: number,
  checkedAt: string,
): Promise<number> {
  if (amountMicrousd === 0) return 0;
  const protection = await activePromotionalProtection(executor, identity);
  const grants = await executor.selectFrom("ai_funded_promotional_grant_balances")
    .selectAll()
    .where("machine_id", "=", identity.machineId)
    .where("owner_id", "=", identity.ownerId)
    .where("runtime_slot", "=", identity.runtimeSlot)
    .where("remaining_microusd", ">", 0)
    .orderBy(sql<number>`CASE WHEN expires_at IS NOT NULL AND expires_at <= ${checkedAt} THEN 0 ELSE 1 END`)
    .orderBy("expires_at").orderBy("created_at").orderBy("grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1)
    .forUpdate().execute();
  if (grants.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
    throw new Error("Funded AI promotional grant limit invariant violated");
  }
  const debitableGrants = grants.map((grant) => {
    const remaining = exactInteger(grant.remaining_microusd);
    const protectedMicrousd = protection.get(grant.grant_entry_id) ?? 0;
    const available = remaining - protectedMicrousd;
    if (available < 0) throw new Error("Funded AI promotional allocation invariant violated");
    return { grant, remaining, available };
  });
  let totalAvailable = 0;
  for (const { available } of debitableGrants) totalAvailable = exactInteger(totalAvailable + available);
  // Legacy reservations have no trustworthy per-source attribution. Never
  // partially debit their inferred promotional share: callers must either
  // fund the complete provider actual from live sources or close the hold
  // without recording a settlement.
  if (totalAvailable < amountMicrousd) return 0;
  const debitTarget = amountMicrousd;

  let remainingDebit = debitTarget;
  for (const { grant, remaining, available } of debitableGrants) {
    if (remainingDebit === 0) break;
    const debit = Math.min(available, remainingDebit);
    if (debit === 0) continue;
    const updated = await executor.updateTable("ai_funded_promotional_grant_balances").set({
      remaining_microusd: remaining - debit,
      updated_at: checkedAt,
      revision: grant.revision + 1,
    }).where("grant_entry_id", "=", grant.grant_entry_id)
      .where("revision", "=", grant.revision)
      .returning("grant_entry_id").executeTakeFirst();
    if (!updated) throw new Error("Funded AI promotional grant revision invariant violated");
    remainingDebit -= debit;
  }
  if (remainingDebit !== 0) throw new Error("Funded AI promotional grant balance invariant violated");
  return debitTarget;
}

export async function debitAttributedPromotionalGrants(
  executor: PlatformDB["executor"],
  reservationId: string,
  amountMicrousd: number,
  checkedAt: string,
): Promise<void> {
  if (amountMicrousd === 0) return;
  const allocations = await executor.selectFrom("ai_funded_reservation_promotional_allocations as allocation")
    .innerJoin(
      "ai_funded_promotional_grant_balances as promo_grant",
      "promo_grant.grant_entry_id",
      "allocation.grant_entry_id",
    )
    .select([
      "allocation.grant_entry_id", "allocation.amount_microusd",
      "promo_grant.expires_at", "promo_grant.created_at",
    ]).where("allocation.reservation_id", "=", reservationId)
    .orderBy(sql<number>`CASE WHEN promo_grant.expires_at IS NULL THEN 1 ELSE 0 END`)
    .orderBy("promo_grant.expires_at").orderBy("promo_grant.created_at").orderBy("allocation.grant_entry_id")
    .limit(MAX_PROMOTIONAL_GRANTS_PER_RUNTIME + 1).execute();
  if (allocations.length > MAX_PROMOTIONAL_GRANTS_PER_RUNTIME) {
    throw new Error("Funded AI promotional allocation limit invariant violated");
  }
  let remainingDebit = amountMicrousd;
  for (const allocation of allocations) {
    if (remainingDebit === 0) break;
    const debit = Math.min(exactInteger(allocation.amount_microusd), remainingDebit);
    const updated = await executor.updateTable("ai_funded_promotional_grant_balances").set({
      remaining_microusd: sql<number>`remaining_microusd - ${debit}`,
      updated_at: checkedAt,
      revision: sql<number>`revision + 1`,
    }).where("grant_entry_id", "=", allocation.grant_entry_id)
      .where("remaining_microusd", ">=", debit)
      .returning("grant_entry_id").executeTakeFirst();
    if (!updated) throw new Error("Funded AI promotional grant allocation invariant violated");
    remainingDebit -= debit;
  }
  if (remainingDebit !== 0) throw new Error("Funded AI promotional allocation balance invariant violated");
}

export async function reservationDebitSplit(
  executor: PlatformDB["executor"],
  identity: FundedAiRuntimeIdentity,
  reservation: {
    reserved_microusd: unknown;
    promotional_reserved_microusd: unknown;
    addon_reserved_microusd: unknown;
  },
  actualCostMicrousd: number,
  balance: FundedAiReservationBalance,
): Promise<{ promotionalDebit: number; addonDebit: number; attributed: boolean }> {
  if (reservation.promotional_reserved_microusd === null
    || reservation.addon_reserved_microusd === null) {
    const protectedAddon = await activeAddonProtection(executor, identity);
    const availableAddon = Math.max(0, exactInteger(balance.addon_balance_microusd) - protectedAddon);
    const addonDebit = Math.min(actualCostMicrousd, availableAddon);
    return { promotionalDebit: actualCostMicrousd - addonDebit, addonDebit, attributed: false };
  }
  const promotionalReserved = exactInteger(reservation.promotional_reserved_microusd);
  const addonReserved = exactInteger(reservation.addon_reserved_microusd);
  if (promotionalReserved + addonReserved !== exactInteger(reservation.reserved_microusd)) {
    throw new Error("Funded AI reservation source allocation invariant violated");
  }
  const promotionalDebit = Math.min(actualCostMicrousd, promotionalReserved);
  const addonDebit = actualCostMicrousd - promotionalDebit;
  if (addonDebit > addonReserved) throw new Error("Funded AI add-on allocation invariant violated");
  return { promotionalDebit, addonDebit, attributed: true };
}
