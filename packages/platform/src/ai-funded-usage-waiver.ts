import { sql } from "kysely";
import type { z } from "zod/v4";
import type { PlatformDB } from "./db.js";
import { withAccountDeletionOwnerLock } from "./account-deletion/admission.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { exactInteger } from "./ai-funded-metering-helpers.js";
import { reconcileExpiredPromotionalCredit } from "./ai-funded-reservation-sources.js";
import { readFundedRecoveryAudit } from "./ai-funded-recovery-audit.js";
import { readUnknownUsageWaivers } from "./ai-funded-usage-waiver-admission.js";
import { assertWaiverDeletionMode } from "./ai-funded-usage-waiver-deletion.js";
import {
  ExpiredUsageWaiverRequestSchema, UsageWaiverResponseSchema, assertWaiverSnapshot, readUsageWaiverAudit,
  waiverFingerprint, USAGE_WAIVER_GRACE_MS, USAGE_WAIVER_MIN_AGE_MS,
  waiverHash,
  USAGE_WAIVER_MAX_RECORDS, USAGE_WAIVER_MAX_LIABILITY_MICROUSD,
} from "./ai-funded-usage-waiver-audit.js";

/** Operator dependency only. Never register this function on a runtime/owner/Relay route. */
export function createExpiredUsageWaiver(options: { db: PlatformDB; now: () => Date }) {
  return async (input: z.input<typeof ExpiredUsageWaiverRequestSchema>, mode: { apply?: boolean } = {}) => {
    const request = ExpiredUsageWaiverRequestSchema.parse(input);
    const apply = mode.apply === true;
    const deletionEnv = { ...process.env };
    const fingerprint = waiverFingerprint(request);
    const checked = options.now();
    if (!Number.isFinite(checked.getTime())) throw new AiFundedPolicyError("unavailable");
    await options.db.ready;
    return options.db.transaction(async (transaction) => {
      if (!apply) await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(transaction.executor);
      await assertWaiverDeletionMode(transaction, request.accountDeletionMode, apply, deletionEnv);
      return withAccountDeletionOwnerLock(transaction, request.identity.ownerId, async (trx, deletion) => {
        if (!deletion.newWorkAllowed) throw new AiFundedPolicyError("access_disabled");
        // Admission lock order: account deletion -> funded owner -> runtime -> machine -> rows -> balance.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${request.identity.ownerId}`}, 0))`.execute(trx.executor);
        const lock = <T extends { forUpdate(): T }>(query: T): T => apply ? query.forUpdate() : query;
        const runtime = await lock(trx.executor.selectFrom("ai_funded_runtime_policies").selectAll()
          .where("machine_id", "=", request.identity.machineId)).executeTakeFirst();
        const machine = await lock(trx.executor.selectFrom("user_machines").selectAll()
          .where("machine_id", "=", request.identity.machineId)).executeTakeFirst();
        if (!machine || !runtime || machine.clerk_user_id !== request.identity.ownerId
          || machine.runtime_slot !== "primary" || machine.status !== "running"
          || machine.activation_state !== "authorized" || machine.deleted_at !== null
          || machine.runtime_token_epoch !== request.expectedRuntimeTokenEpoch
          || runtime.owner_id !== request.identity.ownerId || runtime.runtime_slot !== "primary") {
          throw new AiFundedPolicyError("identity_mismatch");
        }
        const ids = request.reservations.map((item) => item.reservationId);
        const rows = await lock(trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
          .where("reservation_id", "in", ids).orderBy("reservation_id")).execute();
        if (rows.length !== ids.length) throw new AiFundedPolicyError("idempotency_conflict");
        for (const row of rows) {
          const expected = request.reservations.find((item) => item.reservationId === row.reservation_id)!;
          assertWaiverSnapshot(row, request, expected);
          if (row.execution_admission_release !== null) readFundedRecoveryAudit(row);
        }
        const previous = rows.filter((row) => row.charge_waiver !== null);
        if (previous.length) {
          if (previous.length !== rows.length) throw new AiFundedPolicyError("idempotency_conflict");
          const audits = previous.map(readUsageWaiverAudit);
          if (audits.some((audit) => audit.response.fingerprint !== fingerprint
            || JSON.stringify(audit.response) !== JSON.stringify(audits[0].response))) {
            throw new AiFundedPolicyError("idempotency_conflict");
          }
          // Read-only replay reports the stored disposition but cannot apply twice.
          return apply ? audits[0].response : { ...audits[0].response, mode: "dry-run" as const };
        }
        for (const row of rows) {
          if (row.status !== "in_flight" || row.actual_microusd !== null || row.settlement_response !== null
            || row.settled_at !== null || row.released_at !== null) throw new AiFundedPolicyError("reservation_closed");
          if (!row.started_at || Date.parse(row.expires_at) + USAGE_WAIVER_GRACE_MS > checked.getTime()
            || Date.parse(row.started_at) + USAGE_WAIVER_MIN_AGE_MS > checked.getTime()) {
            throw new AiFundedPolicyError("rate_limited");
          }
        }
        const allocations = await trx.executor.selectFrom("ai_funded_reservation_promotional_allocations")
          .select(["reservation_id", "grant_entry_id", "amount_microusd"])
          .where("reservation_id", "in", ids).orderBy("grant_entry_id").limit(USAGE_WAIVER_MAX_RECORDS * 64 + 1).execute();
        if (allocations.length > USAGE_WAIVER_MAX_RECORDS * 64) throw new AiFundedPolicyError("idempotency_conflict");
        for (const row of rows) {
          const sources = allocations.filter((item) => item.reservation_id === row.reservation_id)
            .map((item) => ({ grantEntryId: item.grant_entry_id, amountMicrousd: exactInteger(item.amount_microusd) }));
          const expected = request.reservations.find((item) => item.reservationId === row.reservation_id)!;
          if (sources.length > 64 || waiverHash(JSON.stringify(sources)) !== expected.fundingAllocationSha256
            || (expected.promotionalReservedMicrousd !== null
              && sources.reduce((sum, item) => sum + item.amountMicrousd, 0) !== expected.promotionalReservedMicrousd)) {
            throw new AiFundedPolicyError("idempotency_conflict");
          }
        }
        const otherLive = await trx.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id")
          .where("owner_id", "=", request.identity.ownerId).where("reservation_id", "not in", ids)
          .where("status", "in", ["reserved", "starting", "in_flight", "settling", "releasing"])
          .limit(1).executeTakeFirst();
        if (otherLive) throw new AiFundedPolicyError("rate_limited");
        // Unknown Matrix expense has its own bounded inventory, distinct from the unchanged recovery caps.
        const unknown = await readUnknownUsageWaivers(trx.executor, request.identity.ownerId);
        if (unknown.rows.length + rows.length > USAGE_WAIVER_MAX_RECORDS
          || unknown.liabilityMicrousd + request.expectedMaximumLiabilityMicrousd > USAGE_WAIVER_MAX_LIABILITY_MICROUSD) {
          throw new AiFundedPolicyError("rate_limited");
        }
        const balance = await lock(trx.executor.selectFrom("ai_funded_runtime_balances").selectAll()
          .where("machine_id", "=", request.identity.machineId)
          .where("owner_id", "=", request.identity.ownerId).where("runtime_slot", "=", "primary")).executeTakeFirstOrThrow();
        const samePeriodReserved = rows.filter((row) => row.period_start === balance.month_period_start)
          .reduce((sum, row) => sum + exactInteger(row.reserved_microusd), 0);
        if (exactInteger(balance.reserved_microusd) < request.expectedReleasedMicrousd
          || exactInteger(balance.month_reserved_microusd) < samePeriodReserved) {
          throw new AiFundedPolicyError("idempotency_conflict");
        }
        const response = UsageWaiverResponseSchema.parse({ contractVersion: 1, mode: apply ? "applied" : "dry-run",
          fingerprint, releasedMicrousd: request.expectedReleasedMicrousd,
          maximumLiabilityMicrousd: request.expectedMaximumLiabilityMicrousd,
          usageKnown: false, waivedAt: checked.toISOString() });
        if (!apply) return response;
        const changed = await trx.executor.updateTable("ai_funded_runtime_balances").set({
          reserved_microusd: sql<number>`reserved_microusd - ${request.expectedReleasedMicrousd}`,
          month_reserved_microusd: sql<number>`month_reserved_microusd - ${samePeriodReserved}`,
          updated_at: checked.toISOString(),
        }).where("machine_id", "=", request.identity.machineId).where("owner_id", "=", request.identity.ownerId)
          .where("runtime_slot", "=", "primary").where("reserved_microusd", ">=", request.expectedReleasedMicrousd)
          .where("month_reserved_microusd", ">=", samePeriodReserved).returning("machine_id").executeTakeFirst();
        if (!changed) throw new AiFundedPolicyError("revision_conflict");
        const updated = await trx.executor.updateTable("ai_funded_usage_reservations").set({
          status: "waived", charge_waiver: JSON.stringify({ request, response }),
        }).where("reservation_id", "in", ids).where("status", "=", "in_flight")
          .where("actual_microusd", "is", null).where("charge_waiver", "is", null)
          .returning("reservation_id").execute();
        if (updated.length !== rows.length) throw new AiFundedPolicyError("revision_conflict");
        await reconcileExpiredPromotionalCredit(trx.executor, request.identity, checked.toISOString());
        return response;
      }, deletionEnv);
    });
  };
}
