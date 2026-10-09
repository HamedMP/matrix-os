import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";
import { readUsageWaiverAudit } from "../../ai-funded-usage-waiver-audit.js";

/** Additive audit bytes; status is distinct from exact settlement. Run under the schema lock. */
export async function migrateUsageWaivers(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS charge_waiver TEXT
    CHECK (charge_waiver IS NULL OR octet_length(charge_waiver) <= 65536)`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT IF EXISTS ai_funded_usage_reservations_status_check`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_usage_reservations_status_check
    CHECK (status IN ('reserved','starting','in_flight','settling','releasing','settled','released','expired','waived'))`.execute(db);
  await sql`DO $$ BEGIN
    BEGIN
      ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_charge_waiver_state_check CHECK (
        (charge_waiver IS NULL OR status IN ('waived','settled')) AND
        (status <> 'waived' OR (charge_waiver IS NOT NULL AND actual_microusd IS NULL
          AND settlement_response IS NULL AND settled_at IS NULL)));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END $$`.execute(db);
  let cursor = "";
  for (;;) {
    const rows = await db.selectFrom("ai_funded_usage_reservations").selectAll()
      .where("charge_waiver", "is not", null).where("reservation_id", ">", cursor)
      .orderBy("reservation_id").limit(100).execute();
    for (const row of rows) readUsageWaiverAudit(row);
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].reservation_id;
  }
}
