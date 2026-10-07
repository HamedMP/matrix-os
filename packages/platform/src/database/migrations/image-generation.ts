import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";
export async function migrateImageGeneration(db: PlatformMigrationExecutor): Promise<void> {
    await sql `CREATE TABLE IF NOT EXISTS image_owner_admissions (owner_id TEXT PRIMARY KEY)`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS image_monthly_allowances (
  owner_id TEXT NOT NULL, period_start TEXT NOT NULL, granted_microusd BIGINT NOT NULL CHECK(granted_microusd > 0),
  spent_microusd BIGINT NOT NULL DEFAULT 0 CHECK(spent_microusd >= 0), reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK(reserved_microusd >= 0),
  PRIMARY KEY(owner_id, period_start), CHECK(spent_microusd + reserved_microusd <= granted_microusd)
 )`.execute(db);
    await sql `CREATE TABLE IF NOT EXISTS image_generation_operations (
  owner_id TEXT NOT NULL, request_id TEXT NOT NULL, machine_id TEXT NOT NULL REFERENCES user_machines(machine_id), runtime_slot TEXT NOT NULL,
  period_start TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('dispatching','succeeded','uncertain')),
  reserved_microusd BIGINT NOT NULL CHECK(reserved_microusd > 0), actual_microusd BIGINT CHECK(actual_microusd >= 0),
  reconciliation_evidence TEXT CHECK(length(reconciliation_evidence) BETWEEN 8 AND 256),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, request_id),
  FOREIGN KEY(owner_id, period_start) REFERENCES image_monthly_allowances(owner_id, period_start),
  CHECK((state='succeeded' AND actual_microusd IS NOT NULL AND actual_microusd <= reserved_microusd) OR (state<>'succeeded' AND actual_microusd IS NULL))
 )`.execute(db);
    await sql `CREATE INDEX IF NOT EXISTS image_generation_owner_state ON image_generation_operations(owner_id, state)`.execute(db);
}
