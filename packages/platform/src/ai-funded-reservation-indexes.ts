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
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_funded_usage_active_owner
    ON ai_funded_usage_reservations(owner_id)
    WHERE status IN ('reserved', 'starting', 'in_flight', 'settling')
      AND authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'
  `.execute(db);
}
