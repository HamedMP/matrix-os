import { FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS, FundedAiAuthorizationResponseSchema, FundedAiExecutionRecoveryRequestSchema, FundedAiExecutionRecoveryResponseSchema, FundedAiExecutionRecoveryBatchRequestSchema, FundedAiExecutionRecoveryBatchResponseSchema, FundedAiTerminalOutcomeRequestSchema, } from "@matrix-os/contracts";
import { createHash } from "node:crypto";
import { readTerminalOutcome, readTerminalStart } from "./ai-funded-terminal-outcome.js";
import type { Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
const LegacyAuditSchema = z.object({
  request: FundedAiExecutionRecoveryRequestSchema,
  response: FundedAiExecutionRecoveryResponseSchema,
}).strict();
const BatchAuditSchema = z.object({ kind: z.literal("operator_batch_v2"),
  request: FundedAiExecutionRecoveryBatchRequestSchema, response: FundedAiExecutionRecoveryBatchResponseSchema }).strict();
const RelayAuditSchema = z.object({ kind: z.literal("relay_terminal_v2"),
  request: FundedAiTerminalOutcomeRequestSchema, response: FundedAiExecutionRecoveryResponseSchema }).strict();
const AuditSchema = z.union([LegacyAuditSchema, BatchAuditSchema, RelayAuditSchema]);
const SpeechAuthorizationSchema = z.object({ capability: z.literal("speech:transcribe"),
  policyRevision: z.string().min(1).max(160), fundingPolicy: z.literal("speech_monthly_v1").optional() }).strict();
type Reservation = Selectable<AiFundedUsageReservationsTable>;
function parseSaved<T>(text: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(text));
  }
  catch (error) {
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
/** Source-aware liability; speech's saved hold is its captured maximum, never a fabricated usage authorization. */
export function readFundedRecoveryLiability(row: Reservation) {
  let value: unknown;
  try {
    value = JSON.parse(row.authorization_response);
  }
  catch (error) {
    if (error instanceof SyntaxError)
      throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
  if (SpeechAuthorizationSchema.safeParse(value).success) {
    if (!/^speech_[a-f0-9]{48}$/.test(row.token_id) || !Number.isSafeInteger(Number(row.reserved_microusd))
      || Number(row.reserved_microusd) <= 0)
      throw new AiFundedPolicyError("idempotency_conflict");
    return { fundingKind: "speech" as const, maximumLiabilityMicrousd: Number(row.reserved_microusd) };
  }
  return { fundingKind: "usage" as const, maximumLiabilityMicrousd: readFundedUsageAuthorization(row).reservation.maxCostMicrousd! };
}
/** Strict v1/v2 audit reader shared by admission, migration and settlement. */
export function readFundedRecoveryAudit(row: Reservation) {
  if (row.execution_admission_release === null)
    throw new AiFundedPolicyError("idempotency_conflict");
  const liability = readFundedRecoveryLiability(row);
  const audit = parseSaved(row.execution_admission_release, AuditSchema);
  let request: z.infer<typeof FundedAiExecutionRecoveryRequestSchema>;
  let response: z.infer<typeof FundedAiExecutionRecoveryResponseSchema>;
  let strongReceivedAt: string | undefined;
  if ("kind" in audit && audit.kind === "operator_batch_v2") {
    const item = audit.request.reservations.find((r) => r.reservationId === row.reservation_id);
    const result = audit.response.reservations.find((r) => r.reservationId === row.reservation_id);
    if (!item || !result || item.ownerId !== row.owner_id || item.machineId !== row.machine_id || item.runtimeSlot !== row.runtime_slot
      || item.fundingKind !== liability.fundingKind || item.authorizationSha256 !== createHash("sha256").update(row.authorization_response).digest("hex")
      || audit.response.maximumLiabilityMicrousd !== audit.request.reservations.reduce((sum, r) => sum + r.maximumLiabilityMicrousd, 0)
      || audit.response.reservations.length !== audit.request.reservations.length
      || new Set(audit.response.reservations.map((r) => r.reservationId)).size !== audit.response.reservations.length
      || audit.request.reservations.some((r) => !audit.response.reservations.some((v) => v.reservationId === r.reservationId
        && v.maximumLiabilityMicrousd === r.maximumLiabilityMicrousd)))
      throw new AiFundedPolicyError("idempotency_conflict");
    request = { expectedOwnerId: audit.request.expectedOwnerId, reservationId: item.reservationId, tokenId: item.tokenId,
      expectedRequestId: item.expectedRequestId, expectedStartedAt: item.expectedStartedAt, expectedExpiresAt: item.expectedExpiresAt,
      maximumLiabilityMicrousd: item.maximumLiabilityMicrousd, localRunId: item.localRunId, localRunState: item.localRunState,
      localRunEndedAt: item.localRunEndedAt, reviewer: audit.request.reviewer, evidenceRef: audit.request.evidenceRef, acceptUnknownUpstreamLiability: true };
    const { reservationId: _id, ...single } = result;
    response = single;
  }
  else if ("kind" in audit && audit.kind === "relay_terminal_v2") {
    const terminal = readTerminalOutcome(row);
    if (liability.fundingKind !== "usage" || JSON.stringify(terminal.request) !== JSON.stringify(audit.request))
      throw new AiFundedPolicyError("idempotency_conflict");
    request = { expectedOwnerId: row.owner_id, reservationId: row.reservation_id, tokenId: row.token_id, expectedRequestId: row.request_id,
      expectedStartedAt: audit.request.startedAt, expectedExpiresAt: audit.request.expiresAt, maximumLiabilityMicrousd: liability.maximumLiabilityMicrousd,
      localRunId: audit.request.executionId, localRunState: audit.request.terminalState, localRunEndedAt: audit.request.terminalAt,
      evidenceRef: "relay:terminal-outcome", reviewer: "system:funded-relay", acceptUnknownUpstreamLiability: true };
    response = audit.response;
    if (readTerminalStart(row).executionId !== undefined) strongReceivedAt = terminal.response.receivedAt;
  }
  else {
    if (liability.fundingKind !== "usage" || "kind" in audit)
      throw new AiFundedPolicyError("idempotency_conflict");
    request = audit.request;
    response = audit.response;
  }
  const released = Date.parse(response.releasedAt);
  if (request.expectedOwnerId !== row.owner_id || request.reservationId !== row.reservation_id
    || request.tokenId !== row.token_id || request.expectedRequestId !== row.request_id
    || request.expectedStartedAt !== row.started_at || request.expectedExpiresAt !== row.expires_at
    || request.maximumLiabilityMicrousd !== liability.maximumLiabilityMicrousd
    || response.maximumLiabilityMicrousd !== request.maximumLiabilityMicrousd
    || response.reservedMicrousd !== Number(row.reserved_microusd)
    || (strongReceivedAt !== undefined
      ? released < Date.parse(strongReceivedAt)
      : released < Date.parse(request.expectedStartedAt) + FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS
        || released < Date.parse(request.expectedExpiresAt)
        || released < Date.parse(request.localRunEndedAt) + 60000))
    throw new AiFundedPolicyError("idempotency_conflict");
  return { request, response };
}
