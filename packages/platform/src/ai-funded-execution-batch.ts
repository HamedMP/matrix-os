import { createHash } from "node:crypto";
import { sql } from "kysely";
import { FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD, FundedAiExecutionRecoveryBatchRequestSchema, FundedAiExecutionRecoveryBatchResponseSchema, type FundedAiExecutionRecoveryBatchRequest } from "@matrix-os/contracts";
import type { PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { readFundedRecoveryAudit, readFundedRecoveryLiability } from "./ai-funded-recovery-audit.js";
import { assertRecoveryAge, assertRecoveryMachine, claimRecoverySlot, hasOtherLiveWork, readRecoveredUnknowns, recoveryResponse } from "./ai-funded-recovery-lifecycle.js";
/** Trusted operator route only. One owner lock and transaction cover the entire reviewed set. */
export function createFundedExecutionBatch(options: {
  db: PlatformDB;
  now: () => Date;
}) {
  return async (input: FundedAiExecutionRecoveryBatchRequest) => {
    const request = FundedAiExecutionRecoveryBatchRequestSchema.parse(input);
    const checked = options.now();
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      const executor = trx.executor;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${request.expectedOwnerId}`}, 0))`.execute(executor);
      const unknown = await readRecoveredUnknowns(executor, request.expectedOwnerId);
      // Stable machine lock order permits one owner with multiple reviewed runtimes.
      for (const item of [...request.reservations].sort((a, b) => a.machineId.localeCompare(b.machineId))) {
        await assertRecoveryMachine(executor, { owner_id: item.ownerId, machine_id: item.machineId, runtime_slot: item.runtimeSlot });
      }
      const rows = [];
      let replay: string | null = null;
      for (const item of request.reservations) {
        const row = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("reservation_id", "=", item.reservationId)
          .where("owner_id", "=", request.expectedOwnerId).where("machine_id", "=", item.machineId).where("runtime_slot", "=", item.runtimeSlot)
          .where("token_id", "=", item.tokenId).forUpdate().executeTakeFirst();
        if (!row)
          throw new AiFundedPolicyError("identity_mismatch");
        const liability = readFundedRecoveryLiability(row);
        if (item.expectedRequestId !== row.request_id || item.expectedStartedAt !== row.started_at || item.expectedExpiresAt !== row.expires_at
          || item.maximumLiabilityMicrousd !== liability.maximumLiabilityMicrousd || item.fundingKind !== liability.fundingKind
          || item.authorizationSha256 !== createHash("sha256").update(row.authorization_response).digest("hex"))
          throw new AiFundedPolicyError("idempotency_conflict");
        if (item.fundingKind === "speech") {
          const credential = await executor.selectFrom("ai_runtime_credentials").select(["owner_id", "machine_id", "runtime_slot", "audience", "scope"])
            .where("token_id", "=", row.token_id).executeTakeFirst();
          if (!credential || credential.owner_id !== row.owner_id || credential.machine_id !== row.machine_id || credential.runtime_slot !== row.runtime_slot
            || credential.audience !== "matrix-platform-speech" || credential.scope !== "speech:transcribe")
            throw new AiFundedPolicyError("identity_mismatch");
        }
        if (row.execution_admission_release !== null) {
          readFundedRecoveryAudit(row);
          const audit = JSON.parse(row.execution_admission_release);
          if (audit.kind !== "operator_batch_v2" || JSON.stringify(audit.request) !== JSON.stringify(request)
            || (replay !== null && replay !== row.execution_admission_release))
            throw new AiFundedPolicyError("idempotency_conflict");
          replay = row.execution_admission_release;
        }
        else {
          if (row.status !== "in_flight" || row.actual_microusd !== null || row.charge_waiver !== null)
            throw new AiFundedPolicyError("reservation_closed");
          assertRecoveryAge(row, item.localRunEndedAt, checked);
        }
        rows.push(row);
      }
      if (replay !== null) {
        if (rows.some((row) => row.execution_admission_release === null))
          throw new AiFundedPolicyError("idempotency_conflict");
        return FundedAiExecutionRecoveryBatchResponseSchema.parse(JSON.parse(replay).response);
      }
      const maximum = request.reservations.reduce((sum, item) => sum + item.maximumLiabilityMicrousd, 0);
      if (maximum + unknown.liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD
        || await hasOtherLiveWork(executor, request.expectedOwnerId, rows.map((r) => r.reservation_id)))
        throw new AiFundedPolicyError("rate_limited");
      const response = FundedAiExecutionRecoveryBatchResponseSchema.parse({ contractVersion: 2, executionAdmissionReleased: true,
        usageKnown: false, maximumLiabilityMicrousd: maximum, reservations: rows.map((row, index) => ({ reservationId: row.reservation_id,
          ...recoveryResponse(row, request.reservations[index].maximumLiabilityMicrousd, checked) })) });
      const audit = JSON.stringify({ kind: "operator_batch_v2", request, response });
      for (const row of rows) {
        const slot = await claimRecoverySlot(executor, request.expectedOwnerId);
        await executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: audit, execution_recovery_slot: slot })
          .where("reservation_id", "=", row.reservation_id).where("status", "=", "in_flight").where("actual_microusd", "is", null)
          .where("execution_admission_release", "is", null).executeTakeFirstOrThrow();
      }
      return response;
    });
  };
}
