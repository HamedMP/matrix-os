import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";

export async function migrateAoedeLive(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE ai_runtime_credentials DROP CONSTRAINT IF EXISTS ai_runtime_credentials_scope_v2_check`.execute(db);
  await sql`ALTER TABLE ai_runtime_credentials ADD CONSTRAINT ai_runtime_credentials_scope_v2_check
    CHECK (scope IN ('ai:invoke', 'speech:transcribe', 'speech:live'))`.execute(db);
  await sql`ALTER TABLE speech_operations
    ADD COLUMN IF NOT EXISTS live_provider_id TEXT,
    ADD COLUMN IF NOT EXISTS live_runtime_epoch INTEGER,
    ADD COLUMN IF NOT EXISTS live_usage_seconds DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS live_rate_microusd_per_minute BIGINT,
    ADD COLUMN IF NOT EXISTS live_attachment_id TEXT,
    ADD COLUMN IF NOT EXISTS live_confirmed BOOLEAN NOT NULL DEFAULT FALSE`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS speech_live_operation ON speech_operations(operation_id)
    WHERE adapter_id = 'aoede-live'`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS speech_live_provider ON speech_operations(live_provider_id)
    WHERE live_provider_id IS NOT NULL`.execute(db);
  // Unconfirmed termination remains an admission fence even after conservative settlement.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS speech_live_owner_active ON speech_operations(owner_id)
    WHERE adapter_id = 'aoede-live' AND live_confirmed = FALSE AND execution_state <> 'cancelled'`.execute(db);
}
