import {
  FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS,
  FundedAiAuthorizationResponseSchema,
  FundedAiExecutionRecoveryRequestSchema,
  FundedAiExecutionRecoveryResponseSchema,
} from "@matrix-os/contracts";
import type { Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";

const AuditSchema = z.object({
  request: FundedAiExecutionRecoveryRequestSchema,
  response: FundedAiExecutionRecoveryResponseSchema,
}).strict();

type Reservation = Selectable<AiFundedUsageReservationsTable>;

function parseSaved<T>(text: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new AiFundedPolicyError("idempotency_conflict");
    }
    throw error;
  }
}

/** Pin saved provider liability to the persisted identity, never the smaller hold. */
export function readFundedUsageAuthorization(row: Reservation) {
  const captured = parseSaved(row.authorization_response, FundedAiAuthorizationResponseSchema);
  if (captured.reservation.billingMode !== "usage"
    || captured.reservation.reservationId !== row.reservation_id
    || captured.reservation.requestId !== row.request_id
    || captured.reservation.modelId !== row.model_id
    || captured.reservation.reservedMicrousd !== Number(row.reserved_microusd)
    || captured.identity.tokenId !== row.token_id
    || captured.identity.ownerId !== row.owner_id
    || captured.identity.machineId !== row.machine_id
    || captured.identity.runtimeSlot !== row.runtime_slot) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  return captured;
}

/** Validate immutable v1 receipts both during recovery and before schema upgrade. */
export function readFundedRecoveryAudit(row: Reservation) {
  if (row.execution_admission_release === null) throw new AiFundedPolicyError("idempotency_conflict");
  const captured = readFundedUsageAuthorization(row);
  const audit = parseSaved(row.execution_admission_release, AuditSchema);
  const { request, response } = audit;
  const released = Date.parse(response.releasedAt);
  if (request.expectedOwnerId !== row.owner_id || request.reservationId !== row.reservation_id
    || request.tokenId !== row.token_id || request.expectedRequestId !== row.request_id
    || request.expectedStartedAt !== row.started_at || request.expectedExpiresAt !== row.expires_at
    || request.maximumLiabilityMicrousd !== captured.reservation.maxCostMicrousd
    || response.maximumLiabilityMicrousd !== request.maximumLiabilityMicrousd
    || response.reservedMicrousd !== Number(row.reserved_microusd)
    || released < Date.parse(request.expectedStartedAt) + FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS
    || released < Date.parse(request.expectedExpiresAt)
    || released < Date.parse(request.localRunEndedAt) + 60_000) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  return audit;
}
