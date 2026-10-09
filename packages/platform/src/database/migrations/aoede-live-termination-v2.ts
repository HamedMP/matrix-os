import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";

export async function migrateAoedeLiveTerminationV2(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE speech_operations
    ADD COLUMN IF NOT EXISTS live_provider_expires_at TEXT,
    ADD COLUMN IF NOT EXISTS live_terminated_at TEXT,
    ADD COLUMN IF NOT EXISTS live_termination_evidence TEXT,
    ADD COLUMN IF NOT EXISTS live_termination_provider_id TEXT,
    ADD COLUMN IF NOT EXISTS live_reconcile_after TEXT`.execute(db);
  // The v1 service only confirmed dispatched rows after a validated session.closed
  // with valid usage. Preserve that existing evidence, not uncertain/local expiry.
  await sql`UPDATE speech_operations SET live_terminated_at = updated_at,
    live_termination_evidence = 'legacy.session.closed', live_termination_provider_id = live_provider_id
    WHERE adapter_id = 'aoede-live' AND live_confirmed = TRUE
      AND dispatch_claimed_at IS NOT NULL AND live_terminated_at IS NULL`.execute(db);
  await sql`DROP INDEX IF EXISTS speech_live_owner_active`.execute(db);
  await sql`CREATE UNIQUE INDEX speech_live_owner_active ON speech_operations(owner_id)
    WHERE adapter_id = 'aoede-live' AND execution_state <> 'cancelled'
      AND (live_terminated_at IS NULL OR execution_state IN ('reserved', 'dispatching'))`.execute(db);
}
