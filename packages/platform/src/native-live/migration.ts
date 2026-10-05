import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../database/migration-types.js";

export async function migrateNativeLive(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS native_live_sessions (
    session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
    runtime_slot TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    model_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    accounting_mode TEXT NOT NULL CHECK (accounting_mode = 'conservative'),
    reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd > 0),
    reported_upper_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reported_upper_microusd >= 0),
    accounted_microusd BIGINT NOT NULL CHECK (accounted_microusd >= 0),
    platform_absorbed_overrun_microusd BIGINT NOT NULL DEFAULT 0 CHECK (platform_absorbed_overrun_microusd >= 0),
    usage_events BIGINT NOT NULL DEFAULT 0 CHECK (usage_events >= 0),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    closed_at TEXT
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_native_live_owner_period ON native_live_sessions(owner_id, period_start)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_native_live_active_expiry ON native_live_sessions(expires_at) WHERE status = 'active'`.execute(db);
}
