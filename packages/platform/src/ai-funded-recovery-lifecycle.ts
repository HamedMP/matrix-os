import { FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN, FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD, FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS, FundedAiExecutionRecoveryResponseSchema } from "@matrix-os/contracts";
import { sql, type Selectable } from "kysely";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { readFundedRecoveryAudit, readFundedRecoveryLiability } from "./ai-funded-recovery-audit.js";
import { readTerminalOutcome, readTerminalStart } from "./ai-funded-terminal-outcome.js";
import { readUnknownUsageWaivers } from "./ai-funded-usage-waiver-admission.js";
type Row = Selectable<AiFundedUsageReservationsTable>;
type Executor = PlatformDB["executor"];
export function assertRecoveryAge(row: Row, terminalAt: string, checked: Date) {
  if (!row.started_at || Date.parse(row.expires_at) > checked.getTime()
    || Date.parse(row.started_at) + FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS > checked.getTime()
    || Date.parse(terminalAt) < Date.parse(row.started_at) || Date.parse(terminalAt) + 60000 > checked.getTime()) {
    throw new AiFundedPolicyError("rate_limited");
  }
}
export async function assertRecoveryMachine(executor: Executor, row: {
  owner_id: string;
  machine_id: string;
  runtime_slot: string;
}) {
  const machine = await executor.selectFrom("user_machines").select(["clerk_user_id", "runtime_slot", "status", "activation_state", "deleted_at"])
    .where("machine_id", "=", row.machine_id).forUpdate().executeTakeFirst();
  if (!machine || machine.clerk_user_id !== row.owner_id || machine.runtime_slot !== row.runtime_slot
    || machine.status !== "running" || machine.activation_state !== "authorized" || machine.deleted_at !== null)
    throw new AiFundedPolicyError("identity_mismatch");
}
/** Caller holds funded owner lock. Validate every unresolved audit before using the exclusion predicate. */
export async function readRecoveredUnknowns(executor: Executor, ownerId: string) {
  await readUnknownUsageWaivers(executor, ownerId);
  const rows = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("owner_id", "=", ownerId)
    .where("execution_admission_release", "is not", null).where("charge_waiver", "is", null).where("actual_microusd", "is", null)
    .limit(FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN + 1).execute();
  const occupied: number[] = [];
  let liability = 0;
  for (const row of rows) {
    const audit = readFundedRecoveryAudit(row);
    if (row.status !== "in_flight" || ![0, 1].includes(row.execution_recovery_slot) || occupied.includes(row.execution_recovery_slot))
      throw new AiFundedPolicyError("idempotency_conflict");
    occupied.push(row.execution_recovery_slot);
    liability += audit.request.maximumLiabilityMicrousd;
  }
  if (rows.length > FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN || liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD)
    throw new AiFundedPolicyError("idempotency_conflict");
  return { rows, occupied, liability };
}
export async function hasOtherLiveWork(executor: Executor, ownerId: string, reviewedIds: string[]) {
  const row = await executor.selectFrom("ai_funded_usage_reservations")
    .select("reservation_id")
    .where("owner_id", "=", ownerId)
    .where("reservation_id", "not in", reviewedIds)
    .where("execution_admission_release", "is", null)
    .where("status", "in", ["reserved", "starting", "in_flight", "settling"])
    .limit(1).executeTakeFirst();
  if (row) return true;

  await readRecoveredUnknowns(executor, ownerId);
  const speech = await executor.selectFrom("speech_operations as operation")
    .leftJoin("ai_funded_usage_reservations as funding", "funding.reservation_id", "operation.funding_reservation_id")
    .select("operation.operation_id")
    .where("operation.owner_id", "=", ownerId)
    .where("operation.execution_state", "in", ["received", "reserved", "dispatching"])
    .where((eb) => eb.or([
      eb("operation.funding_reservation_id", "is", null),
      eb.and([
        eb("operation.funding_reservation_id", "not in", reviewedIds),
        eb("funding.execution_admission_release", "is", null),
      ]),
      sql<boolean>`funding.authorization_response::jsonb ->> 'capability' IS DISTINCT FROM 'speech:transcribe'`,
      eb("funding.reservation_id", "is", null),
      eb("funding.owner_id", "!=", eb.ref("operation.owner_id")),
      eb("funding.machine_id", "!=", eb.ref("operation.machine_id")),
      eb("funding.runtime_slot", "!=", eb.ref("operation.runtime_slot")),
      eb("funding.request_id", "!=", eb.ref("operation.operation_id")),
    ]))
    .limit(1).executeTakeFirst();
  if (speech) return true;

  // Execution release remains authoritative after exact financial settlement.
  // Active speech operation metadata has a hard global ceiling of 1000; bound
  // the audit scan at that ceiling and fail closed on an impossible inventory.
  const releasedSpeech = await executor.selectFrom("speech_operations as operation")
    .innerJoin("ai_funded_usage_reservations as funding", "funding.reservation_id", "operation.funding_reservation_id")
    .selectAll("funding")
    .where("operation.owner_id", "=", ownerId)
    .where("operation.execution_state", "in", ["received", "reserved", "dispatching"])
    .where("funding.reservation_id", "not in", reviewedIds)
    .where("funding.execution_admission_release", "is not", null)
    .whereRef("funding.owner_id", "=", "operation.owner_id")
    .whereRef("funding.machine_id", "=", "operation.machine_id")
    .whereRef("funding.runtime_slot", "=", "operation.runtime_slot")
    .whereRef("funding.request_id", "=", "operation.operation_id")
    .limit(1001).execute();
  if (releasedSpeech.length > 1000) throw new AiFundedPolicyError("idempotency_conflict");
  for (const released of releasedSpeech) {
    if (readFundedRecoveryLiability(released).fundingKind !== "speech") throw new AiFundedPolicyError("idempotency_conflict");
    readFundedRecoveryAudit(released);
  }
  return false;
}

export function recoveryResponse(row: Row, maximum: number, checked: Date) {
  return FundedAiExecutionRecoveryResponseSchema.parse({ contractVersion: 1, executionAdmissionReleased: true, usageKnown: false,
    reservedMicrousd: Number(row.reserved_microusd), maximumLiabilityMicrousd: maximum, releasedAt: checked.toISOString() });
}
/** Receipt-triggered execution recovery, with admission as fallback. No monetary writes. */
export async function recoverTerminalOutcomes(executor: Executor, ownerId: string, checked: Date) {
  const unknown = await readRecoveredUnknowns(executor, ownerId);
  const candidates = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("owner_id", "=", ownerId)
    .where("execution_admission_release", "is", null).where("terminal_outcome", "is not", null).where("charge_waiver", "is", null)
    .where("actual_microusd", "is", null).where("status", "=", "in_flight").limit(FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN + 1).execute();
  if (candidates.length === 0 || candidates.length + unknown.rows.length > FUNDED_EXECUTION_RECOVERY_MAX_UNKNOWN)
    return;
  const valid = [];
  let liability = unknown.liability;
  for (const row of candidates) {
    const terminal = readTerminalOutcome(row);
    try {
      if (readTerminalStart(row).executionId === undefined) assertRecoveryAge(row, terminal.request.terminalAt, checked);
      else if (Date.parse(terminal.response.receivedAt) > checked.getTime())
        throw new AiFundedPolicyError("idempotency_conflict");
    }
    catch (error) {
      if (error instanceof AiFundedPolicyError && error.code === "rate_limited")
        return;
      throw error;
    }
    await assertRecoveryMachine(executor, row);
    const maximum = readFundedRecoveryLiability(row).maximumLiabilityMicrousd;
    liability += maximum;
    valid.push({ row, terminal, maximum });
  }
  if (liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD || await hasOtherLiveWork(executor, ownerId, candidates.map((r) => r.reservation_id)))
    return;
  for (const { row, terminal, maximum } of valid) {
    const slot = unknown.occupied.includes(0) ? 1 : 0;
    unknown.occupied.push(slot);
    await executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: JSON.stringify({ kind: "relay_terminal_v2",
        request: terminal.request, response: recoveryResponse(row, maximum, checked) }), execution_recovery_slot: slot })
      .where("reservation_id", "=", row.reservation_id).where("status", "=", "in_flight")
      .where("actual_microusd", "is", null).where("execution_admission_release", "is", null).executeTakeFirstOrThrow();
  }
}
