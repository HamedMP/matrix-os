import { NoResultError, sql, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { readCustomerFundingCapture, readCustomerChargeRelease, releaseCustomerCharge } from "./ai-funded-customer-charge-release.js";
import { readFundedRecoveryAudit } from "./ai-funded-recovery-audit.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { FundedReferenceSchema } from "./ai-funded-metering-helpers.js";
import { IsoTimestampSchema } from "@matrix-os/contracts";

type Executor = PlatformDB["executor"];
const InputSchema = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
const InventoryInputSchema = InputSchema.extend({ after: z.object({ expiresAt: IsoTimestampSchema, reservationId: FundedReferenceSchema }).strict().optional() });
const ACTIVE = ["reserved", "starting", "in_flight"] as const;
const cleanupCursors = new WeakMap<PlatformDB, { expiresAt: string; reservationId: string }>();

function expiredCustomerRequests(executor: Executor, checkedAt: string) {
  return executor.selectFrom("ai_funded_usage_reservations").selectAll()
    .where("status", "in", [...ACTIVE]).where("expires_at", "<=", checkedAt)
    .where("customer_charge_release", "is", null).where("charge_waiver", "is", null)
    .where("actual_microusd", "is", null)
;
}

function validateLegacyCandidate(row: Selectable<AiFundedUsageReservationsTable>) {
  const captured = readCustomerFundingCapture(row);
  if (row.execution_admission_release !== null) readFundedRecoveryAudit(row);
  return captured;
}

function isDataError(error: unknown) {
  return error instanceof AiFundedPolicyError || error instanceof NoResultError || error instanceof z.ZodError
    || error instanceof Error && /^Funded AI .* invariant violated$/.test(error.message);
}

/** Read-only operator inventory: a bounded page, not an implied financial apply. */
export async function inventoryExpiredCustomerCharges(options: { db: PlatformDB; now: () => Date }, input: z.input<typeof InventoryInputSchema>) {
  const { limit, after } = InventoryInputSchema.parse(input);
  await options.db.ready;
  const asOf = options.now().toISOString();
  let query = expiredCustomerRequests(options.db.executor, asOf);
  if (after) query = query.where(sql<boolean>`(expires_at, reservation_id) > (${after.expiresAt}, ${after.reservationId})`);
  const rows = await query.orderBy("expires_at").orderBy("reservation_id").limit(limit + 1).execute();
  const last = rows.slice(0, limit).at(-1);
  return { policy: "matrix-customer-credit-2026-11-04", asOf, hasMore: rows.length > limit,
    nextCursor: rows.length > limit && last ? { expiresAt: last.expires_at, reservationId: last.reservation_id } : null,
    items: rows.slice(0, limit).map(row => {
      const captured = validateLegacyCandidate(row);
      return { reservationId: row.reservation_id, ownerId: row.owner_id, machineId: row.machine_id,
        runtimeSlot: row.runtime_slot, fundingKind: captured.kind, allowanceReservedMicrousd: captured.allowanceReservedMicrousd, startedAt: row.started_at, expiresAt: row.expires_at,
        releaseMicrousd: Number(row.reserved_microusd), providerUsageKnown: false,
        maximumLiabilityMicrousd: captured.maximumCostMicrousd };
    }) };
}

/** Caller holds the owner lock before machine/request/balance locks. */
export async function cleanupOwnerCustomerCharges(executor: Executor, ownerId: string, checkedAt: string, now: () => Date, limit = 100, candidateIds?: string[]) {
  let query = expiredCustomerRequests(executor, checkedAt).where("owner_id", "=", ownerId);
  if (candidateIds) query = query.where("reservation_id", "in", candidateIds);
  const candidates = await query.orderBy("expires_at").orderBy("reservation_id").limit(limit).execute();
  let cleaned = 0;
  for (const candidate of candidates) {
    await sql`SAVEPOINT customer_credit_candidate`.execute(executor);
    try {
      await executor.selectFrom("user_machines").select("machine_id").where("machine_id", "=", candidate.machine_id).forNoKeyUpdate().executeTakeFirstOrThrow();
      const row = await executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", candidate.reservation_id).forUpdate().executeTakeFirstOrThrow();
      if (row.customer_charge_release !== null) { readCustomerChargeRelease(row); continue; }
      if (!ACTIVE.includes(row.status as typeof ACTIVE[number]) || row.actual_microusd !== null || row.expires_at > checkedAt || row.charge_waiver !== null) continue;
      const captured = validateLegacyCandidate(row);
      await releaseCustomerCharge(executor, row, captured.postpaid ? "expired_request" : "legacy_expired_hold", checkedAt, now);
      cleaned++;
    } catch (error) {
      await sql`ROLLBACK TO SAVEPOINT customer_credit_candidate`.execute(executor);
      if (!isDataError(error)) throw error;
      console.warn("[funded-ai] Customer credit cleanup retained invalid request accounting", {
        reservationId: candidate.reservation_id, errorName: error instanceof Error ? error.name : "UnknownError" });
    } finally { await sql`RELEASE SAVEPOINT customer_credit_candidate`.execute(executor); }
  }
  return cleaned;
}

export async function cleanupExpiredCustomerCharges(options: { db: PlatformDB; now: () => Date }, input: z.input<typeof InputSchema>) {
  const { limit } = InputSchema.parse(input);
  await options.db.ready;
  const checkedAt = options.now().toISOString();
  const cursor = cleanupCursors.get(options.db);
  const selectPage = (after?: typeof cursor, count = limit, through?: typeof cursor) => {
    let query = expiredCustomerRequests(options.db.executor, checkedAt);
    if (after) query = query.where(sql<boolean>`(expires_at, reservation_id) > (${after.expiresAt}, ${after.reservationId})`);
    if (through) query = query.where(sql<boolean>`(expires_at, reservation_id) <= (${through.expiresAt}, ${through.reservationId})`);
    return query.orderBy("expires_at").orderBy("reservation_id").limit(count).execute();
  };
  const rows = await selectPage(cursor);
  if (cursor && rows.length < limit) rows.push(...await selectPage(undefined, limit - rows.length, cursor));
  const owners = [...new Set(rows.map(row => row.owner_id))].sort();
  let cleaned = 0;
  for (const owner of owners) {
    if (cleaned >= limit) break;
    try {
      cleaned += await options.db.transaction(async trx => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${owner}`}, 0))`.execute(trx.executor);
        return cleanupOwnerCustomerCharges(trx.executor, owner, checkedAt, options.now, limit - cleaned,
          rows.filter(row => row.owner_id === owner).map(row => row.reservation_id));
      });
    } catch (error) {
      if (!isDataError(error)) throw error;
      console.warn("[funded-ai] Customer credit cleanup retained invalid owner accounting", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  const last = rows.at(-1);
  if (last) cleanupCursors.set(options.db, { expiresAt: last.expires_at, reservationId: last.reservation_id });
  return cleaned;
}
