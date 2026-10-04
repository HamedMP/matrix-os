import {
  FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS,
  FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD,
  FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN,
  FundedAiExecutionRecoveryRequestSchema,
  FundedAiExecutionRecoveryResponseSchema,
  type FundedAiExecutionRecoveryRequest,
  type FundedAiIdentity,
} from "@matrix-os/contracts";
import { sql } from "kysely";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

import { readFundedRecoveryAudit, readFundedUsageAuthorization } from "./ai-funded-recovery-audit.js";

/** Operator-only recovery, independently fenced from financial settlement. */
export function createFundedExecutionRecovery(options: { db: PlatformDB; now: () => Date }) {
  return async (identity: FundedAiIdentity, input: FundedAiExecutionRecoveryRequest) => {
    const request = FundedAiExecutionRecoveryRequestSchema.parse(input);
    if (identity.ownerId !== request.expectedOwnerId) throw new AiFundedPolicyError("identity_mismatch");
    const checked = options.now();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      // Same namespace/order as admission: concurrent support and Relay replicas
      // serialize the bounded unknown set and cannot open two live execution slots.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`
        .execute(trx.executor);
      const machine = await trx.executor.selectFrom("user_machines")
        .select(["clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at"])
        .where("machine_id", "=", identity.machineId).forUpdate().executeTakeFirst();
      if (!machine || machine.clerk_user_id !== identity.ownerId || machine.runtime_slot !== identity.runtimeSlot
        || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null) {
        throw new AiFundedPolicyError("identity_mismatch");
      }
      const reservation = await trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", request.reservationId).where("token_id", "=", request.tokenId)
        .where("owner_id", "=", identity.ownerId).where("machine_id", "=", identity.machineId)
        .where("runtime_slot", "=", identity.runtimeSlot).forUpdate().executeTakeFirst();
      if (!reservation) throw new AiFundedPolicyError("unauthorized");
      if (reservation.request_id !== request.expectedRequestId || reservation.started_at !== request.expectedStartedAt
        || reservation.expires_at !== request.expectedExpiresAt) throw new AiFundedPolicyError("idempotency_conflict");
      const captured = readFundedUsageAuthorization(reservation);
      if (captured.reservation.maxCostMicrousd !== request.maximumLiabilityMicrousd) {
        throw new AiFundedPolicyError("idempotency_conflict");
      }
      if (reservation.execution_admission_release !== null) {
        const audit = readFundedRecoveryAudit(reservation);
        if (JSON.stringify(audit.request) !== JSON.stringify(request)) throw new AiFundedPolicyError("idempotency_conflict");
        return audit.response;
      }
      if (reservation.status !== "in_flight" || reservation.actual_microusd !== null) {
        throw new AiFundedPolicyError("reservation_closed");
      }
      // A terminal local run is an operator attestation, not provider-termination
      // proof. Require the entire maximum Relay lifetime plus grace to pass.
      if (Date.parse(reservation.expires_at) > checked.getTime()
        || Date.parse(request.expectedStartedAt) + FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS > checked.getTime()
        || Date.parse(request.localRunEndedAt) + 60_000 > checked.getTime()) {
        throw new AiFundedPolicyError("rate_limited");
      }
      const unknown = await trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("owner_id", "=", identity.ownerId).where("execution_admission_release", "is not", null)
        .where("actual_microusd", "is", null).limit(FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN + 1).execute();
      let liability = request.maximumLiabilityMicrousd;
      const occupied: number[] = [];
      for (const row of unknown) {
        const audit = readFundedRecoveryAudit(row);
        if (row.status !== "in_flight" || ![0, 1].includes(row.execution_recovery_slot)
          || occupied.includes(row.execution_recovery_slot)) throw new AiFundedPolicyError("idempotency_conflict");
        occupied.push(row.execution_recovery_slot);
        liability += audit.request.maximumLiabilityMicrousd;
      }
      const otherLive = await trx.executor.selectFrom("ai_funded_usage_reservations").select("reservation_id")
        .where("owner_id", "=", identity.ownerId).where("reservation_id", "!=", request.reservationId)
        .where("execution_admission_release", "is", null)
        .where("status", "in", ["reserved", "starting", "in_flight", "settling"])
        .limit(1).executeTakeFirst();
      if (unknown.length >= FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN
        || liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD || otherLive) {
        throw new AiFundedPolicyError("rate_limited");
      }
      const recoverySlot: 0 | 1 = occupied.includes(0) ? 1 : 0;
      const response = FundedAiExecutionRecoveryResponseSchema.parse({
        contractVersion: 1, executionAdmissionReleased: true, usageKnown: false,
        reservedMicrousd: Number(reservation.reserved_microusd),
        maximumLiabilityMicrousd: request.maximumLiabilityMicrousd, releasedAt: checked.toISOString(),
      });
      const updated = await trx.executor.updateTable("ai_funded_usage_reservations")
        .set({ execution_admission_release: JSON.stringify({ request, response }), execution_recovery_slot: recoverySlot })
        .where("reservation_id", "=", request.reservationId).where("token_id", "=", request.tokenId)
        .where("owner_id", "=", identity.ownerId).where("status", "=", "in_flight")
        .where("actual_microusd", "is", null).where("execution_admission_release", "is", null)
        .returning("reservation_id").executeTakeFirst();
      if (!updated) throw new AiFundedPolicyError("revision_conflict");
      return response;
    });
  };
}
