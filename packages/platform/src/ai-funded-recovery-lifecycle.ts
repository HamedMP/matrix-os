import { FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD, FUNDED_EXECUTION_RECOVERY_MIN_AGE_MS, FundedAiExecutionRecoveryResponseSchema } from "@matrix-os/contracts";
import { sql, type RawBuilder, type Selectable } from "kysely";
import type { AiFundedUsageReservationsTable, PlatformDB } from "./db.js";
import { AiFundedPolicyError } from "./ai-funded-policy-errors.js";
import { readFundedRecoveryAudit, readFundedRecoveryLiability } from "./ai-funded-recovery-audit.js";
import { readTerminalOutcome, readTerminalStart } from "./ai-funded-terminal-outcome.js";
import { readUnknownUsageWaivers } from "./ai-funded-usage-waiver-admission.js";
type Row = Selectable<AiFundedUsageReservationsTable>;
type Executor = PlatformDB["executor"];
/** Caller holds the funded owner lock; SQL finds a free slot without loading the inventory. */
export async function claimRecoverySlot(executor: Executor, ownerId: string): Promise<number> {
  const result = await sql<{ slot: number | string }>`
    WITH occupied AS (
      SELECT execution_recovery_slot::bigint AS slot FROM ai_funded_usage_reservations
      WHERE owner_id=${ownerId} AND execution_admission_release IS NOT NULL
        AND actual_microusd IS NULL AND charge_waiver IS NULL
    )
    SELECT COALESCE(
      (SELECT 0::bigint WHERE NOT EXISTS (SELECT 1 FROM occupied WHERE slot=0)),
      (SELECT MIN(prior.slot+1) FROM occupied AS prior
        LEFT JOIN occupied AS successor ON successor.slot=prior.slot+1 WHERE successor.slot IS NULL)
    ) AS slot
  `.execute(executor);
  const slot = Number(result.rows[0]?.slot);
  if (!Number.isSafeInteger(slot) || slot < 0) throw new AiFundedPolicyError("idempotency_conflict");
  return slot;
}
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
  let liability = 0;
  let previousSlot = -1;
  let afterId = "";
  for (;;) {
    const rows = await executor.selectFrom("ai_funded_usage_reservations").selectAll().where("owner_id", "=", ownerId)
      .where("execution_admission_release", "is not", null).where("charge_waiver", "is", null).where("actual_microusd", "is", null)
      .where(eb => eb.or([eb("execution_recovery_slot", ">", previousSlot),
        eb.and([eb("execution_recovery_slot", "=", previousSlot), eb("reservation_id", ">", afterId)])]))
      .orderBy("execution_recovery_slot").orderBy("reservation_id").limit(100).execute();
    for (const row of rows) {
      const audit = readFundedRecoveryAudit(row);
      if (row.status !== "in_flight" || !Number.isInteger(row.execution_recovery_slot)
        || row.execution_recovery_slot < 0 || row.execution_recovery_slot <= previousSlot)
        throw new AiFundedPolicyError("idempotency_conflict");
      previousSlot = row.execution_recovery_slot;
      afterId = row.reservation_id;
      liability += audit.request.maximumLiabilityMicrousd;
      if (liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD)
        throw new AiFundedPolicyError("idempotency_conflict");
    }
    if (rows.length < 100) return { liability };
  }
}

export async function hasOtherLiveWork(executor: Executor, ownerId: string, reviewedIds: string[] | RawBuilder<string>) {
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
function terminalCandidateQuery(executor: Executor, ownerId: string) {
  return executor.selectFrom("ai_funded_usage_reservations").where("owner_id", "=", ownerId)
    .where("execution_admission_release", "is", null).where("terminal_outcome", "is not", null).where("charge_waiver", "is", null)
    .where("actual_microusd", "is", null).where("status", "=", "in_flight");
}
async function* terminalCandidates(executor: Executor, ownerId: string) {
  let after = "";
  for (;;) {
    const page = await terminalCandidateQuery(executor, ownerId).selectAll()
      .where("reservation_id", ">", after).orderBy("reservation_id").limit(100).execute();
    for (const row of page) yield row;
    if (page.length < 100) return;
    after = page[page.length - 1].reservation_id;
  }
}
/** Caller holds the owner lock. Validate the whole set before writes, keeping only a page in memory. */
export async function recoverTerminalOutcomes(executor: Executor, ownerId: string, checked: Date) {
  const unknown = await readRecoveredUnknowns(executor, ownerId);
  let liability = unknown.liability;
  let found = false;
  for await (const row of terminalCandidates(executor, ownerId)) {
    found = true;
    const terminal = readTerminalOutcome(row);
    try {
      if (readTerminalStart(row).executionId === undefined) assertRecoveryAge(row, terminal.request.terminalAt, checked);
      else if (Date.parse(terminal.response.receivedAt) > checked.getTime())
        throw new AiFundedPolicyError("idempotency_conflict");
    } catch (error) {
      if (error instanceof AiFundedPolicyError && error.code === "rate_limited") return;
      throw error;
    }
    await assertRecoveryMachine(executor, row);
    liability += readFundedRecoveryLiability(row).maximumLiabilityMicrousd;
    if (liability > FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD) return;
  }
  if (!found) return;
  // The owner lock keeps this exact, fully validated set stable across both scans.
  const reviewedIds = sql<string>`(${terminalCandidateQuery(executor, ownerId).select("reservation_id")})`;
  if (await hasOtherLiveWork(executor, ownerId, reviewedIds)) return;
  for await (const row of terminalCandidates(executor, ownerId)) {
    const terminal = readTerminalOutcome(row);
    const maximum = readFundedRecoveryLiability(row).maximumLiabilityMicrousd;
    const slot = await claimRecoverySlot(executor, ownerId);
    await executor.updateTable("ai_funded_usage_reservations").set({ execution_admission_release: JSON.stringify({ kind: "relay_terminal_v2",
        request: terminal.request, response: recoveryResponse(row, maximum, checked) }), execution_recovery_slot: slot })
      .where("reservation_id", "=", row.reservation_id).where("status", "=", "in_flight")
      .where("actual_microusd", "is", null).where("execution_admission_release", "is", null).executeTakeFirstOrThrow();
  }
}
