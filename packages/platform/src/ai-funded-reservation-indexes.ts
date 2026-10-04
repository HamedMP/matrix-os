import { sql, type Kysely } from "kysely";
import type { PlatformDatabase } from "./db.js";

/** Durable owner admission invariant, including independent relay replicas. */
export async function ensureFundedReservationIndexes(db: Kysely<PlatformDatabase>): Promise<void> {
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_funded_unknown_admission_owner
    ON ai_funded_usage_reservations(owner_id)
    WHERE execution_admission_release IS NOT NULL AND actual_microusd IS NULL
  `.execute(db);
}
