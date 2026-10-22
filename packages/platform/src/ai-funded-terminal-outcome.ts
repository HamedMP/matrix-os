import { FundedAiStartResponseSchema, FundedAiTerminalOutcomeRequestSchema, FundedAiTerminalOutcomeResponseSchema, type FundedAiTerminalOutcomeRequest } from "@matrix-os/contracts";
import { sql, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { readFundedUsageAuthorization } from "./ai-funded-recovery-audit.js";
import { assertRecoveryMachine } from "./ai-funded-recovery-lifecycle.js";
import { recoverFundedTerminalReceipt } from "./ai-funded-terminal-reconciliation.js";
export const TerminalOutcomeAuditSchema = z.object({ request: FundedAiTerminalOutcomeRequestSchema,
  response: FundedAiTerminalOutcomeResponseSchema }).strict();
export function readTerminalOutcome(row: Selectable<AiFundedUsageReservationsTable>) {
  try {
    const audit = TerminalOutcomeAuditSchema.parse(JSON.parse(row.terminal_outcome!));
    assertTerminalBinding(row, audit.request);
    if (Date.parse(audit.response.receivedAt) < Date.parse(audit.request.terminalAt))
      throw new AiFundedPolicyError("idempotency_conflict");
    return audit;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
}
function assertTerminalBinding(row: Selectable<AiFundedUsageReservationsTable>, request: FundedAiTerminalOutcomeRequest) {
  readFundedUsageAuthorization(row);
  if (request.ownerId !== row.owner_id || request.machineId !== row.machine_id || request.runtimeSlot !== row.runtime_slot
    || request.tokenId !== row.token_id || request.reservationId !== row.reservation_id)
    throw new AiFundedPolicyError("identity_mismatch");
  if (request.requestId !== row.request_id || request.startedAt !== row.started_at || request.expiresAt !== row.expires_at) {
    throw new AiFundedPolicyError("idempotency_conflict");
  }
  const start = readTerminalStart(row);
  if (start.executionId !== undefined && start.executionId !== request.executionId)
    throw new AiFundedPolicyError("idempotency_conflict");
}
/** The persisted start pins one dispatch attempt; old unbound starts remain legacy evidence. */
export function readTerminalStart(row: Selectable<AiFundedUsageReservationsTable>) {
  try {
    const start = FundedAiStartResponseSchema.parse(JSON.parse(row.start_response!));
    if (start.reservationId !== row.reservation_id || start.tokenId !== row.token_id || start.requestId !== row.request_id
      || start.startedAt !== row.started_at || start.expiresAt !== row.expires_at)
      throw new AiFundedPolicyError("idempotency_conflict");
    return start;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      throw new AiFundedPolicyError("idempotency_conflict");
    throw error;
  }
}
/** Only the control-authenticated Relay route may call this; receipt acceptance does not settle money. */
export function createFundedTerminalOutcome(options: {
  db: PlatformDB;
  now: () => Date;
}) {
  return async (input: FundedAiTerminalOutcomeRequest) => {
    const request = FundedAiTerminalOutcomeRequestSchema.parse(input);
    await options.db.ready;
    return options.db.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${request.ownerId}`}, 0))`.execute(trx.executor);
      // Policy updates lock the machine before reservations. Do not invert that order.
      await assertRecoveryMachine(trx.executor, { owner_id: request.ownerId, machine_id: request.machineId, runtime_slot: request.runtimeSlot });
      const row = await trx.executor.selectFrom("ai_funded_usage_reservations").selectAll()
        .where("reservation_id", "=", request.reservationId).where("token_id", "=", request.tokenId).forUpdate().executeTakeFirst();
      if (!row)
        throw new AiFundedPolicyError("unauthorized");
      assertTerminalBinding(row, request);
      const checked = options.now();
      const checkedAt = checked.toISOString();
      if (Date.parse(request.terminalAt) > Date.parse(checkedAt))
        throw new AiFundedPolicyError("idempotency_conflict");
      if (row.terminal_outcome !== null) {
        const audit = readTerminalOutcome(row);
        if (JSON.stringify(audit.request) !== JSON.stringify(request))
          throw new AiFundedPolicyError("idempotency_conflict");
        await recoverFundedTerminalReceipt(trx.executor, request.ownerId, checked);
        return audit.response;
      }
      const response = FundedAiTerminalOutcomeResponseSchema.parse({ contractVersion: 1, outcomeAccepted: true, usageKnown: false, receivedAt: checkedAt });
      // Exact settlement wins monotonically, including when it preceded the unknown outcome.
      const settled = row.status === "settled" && row.actual_microusd !== null;
      if (!settled && (row.status !== "in_flight" || row.actual_microusd !== null || row.charge_waiver !== null))
        throw new AiFundedPolicyError("reservation_closed");
      await trx.executor.updateTable("ai_funded_usage_reservations").set({ terminal_outcome: JSON.stringify({ request, response }) })
        .where("reservation_id", "=", row.reservation_id).where("terminal_outcome", "is", null).executeTakeFirstOrThrow();
      await recoverFundedTerminalReceipt(trx.executor, request.ownerId, checked);
      return response;
    });
  };
}
