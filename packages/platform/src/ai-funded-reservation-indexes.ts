import { sql, type Kysely } from "kysely";
import { FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD } from "@matrix-os/contracts";
import { readFundedRecoveryAudit } from "./ai-funded-recovery-audit.js";
import type { PlatformDatabase } from "./db.js";

/** Durable owner admission invariant, including independent relay replicas. */
export async function ensureFundedReservationIndexes(db: Kysely<PlatformDatabase>): Promise<void> {
  if (!db.isTransaction) {
    await db.transaction().execute(ensureFundedReservationIndexes);
    return;
  }
  // Migration runs under the schema transaction lock. Hold writes while
  // validating legacy receipts before assigning the conservative default slot.
  await sql`LOCK TABLE ai_funded_usage_reservations IN SHARE ROW EXCLUSIVE MODE`.execute(db);
  let cursor = "";
  for (;;) {
    const batch = await db.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("execution_admission_release", "is not", null).where("actual_microusd", "is", null)
      .where("charge_waiver", "is", null)
      .where("reservation_id", ">", cursor).orderBy("reservation_id").limit(100).execute();
    for (const row of batch) {
      readFundedRecoveryAudit(row);
      if (row.status !== "in_flight") throw new Error("Invalid unresolved funded recovery status");
    }
    if (batch.length < 100) break;
    cursor = batch[batch.length - 1].reservation_id;
  }
  const excessive = await sql`
    SELECT owner_id FROM ai_funded_usage_reservations
    WHERE execution_admission_release IS NOT NULL AND actual_microusd IS NULL AND charge_waiver IS NULL
    GROUP BY owner_id
    HAVING SUM(CASE WHEN authorization_response::jsonb ->> 'capability' = 'speech:transcribe'
        THEN reserved_microusd ELSE (authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint END)
        > ${FUNDED_EXECUTION_RECOVERY_MAX_LIABILITY_MICROUSD}
    LIMIT 1
  `.execute(db);
  if (excessive.rows.length) throw new Error("Funded recovery liability exceeds owner bound");
  await sql`
    ALTER TABLE ai_funded_usage_reservations
    ADD COLUMN IF NOT EXISTS execution_recovery_slot INTEGER NOT NULL DEFAULT 0
  `.execute(db);
  // Upgrade existing two-slot schemas in the same locked migration transaction.
  await sql`
    ALTER TABLE ai_funded_usage_reservations
      DROP CONSTRAINT IF EXISTS ai_funded_execution_recovery_slot_check,
      ALTER COLUMN execution_recovery_slot TYPE INTEGER,
      ADD CONSTRAINT ai_funded_execution_recovery_slot_check
        CHECK (execution_recovery_slot >= 0)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_reservations_runtime_status
    ON ai_funded_usage_reservations(machine_id, runtime_slot, status, expires_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_reservations_owner_status
    ON ai_funded_usage_reservations(owner_id, status)
  `.execute(db);
  // A single transactional statement keeps the original name for old code's
  // CREATE IF NOT EXISTS. Concurrent admissions wait for the DDL table lock;
  // no committed state lacks the execution uniqueness constraint.
  await sql`
    DO $$ BEGIN
      DROP INDEX IF EXISTS idx_ai_funded_usage_active_owner;
      CREATE UNIQUE INDEX idx_ai_funded_usage_active_owner
      ON ai_funded_usage_reservations(owner_id)
      WHERE status IN ('reserved', 'starting', 'in_flight', 'settling')
        AND authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'
        AND execution_admission_release IS NULL;
    END $$
  `.execute(db);
  await sql`
    DO $$ BEGIN
      DROP INDEX IF EXISTS idx_ai_funded_unknown_admission_owner;
      CREATE UNIQUE INDEX idx_ai_funded_unknown_admission_owner
      ON ai_funded_usage_reservations(owner_id, execution_recovery_slot)
      WHERE execution_admission_release IS NOT NULL AND actual_microusd IS NULL AND charge_waiver IS NULL;
    END $$
  `.execute(db);
}
