import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateUserMachines(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS user_machines (
      machine_id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      runtime_slot TEXT NOT NULL DEFAULT 'primary',
      runtime_token_epoch INTEGER NOT NULL DEFAULT 1 CHECK (runtime_token_epoch >= 1),
      provisioning_class TEXT NOT NULL DEFAULT 'customer',
      access_clerk_user_ids TEXT[] NOT NULL DEFAULT '{}',
      developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]',
      hetzner_server_id INTEGER,
      public_ipv4 TEXT,
      public_ipv6 TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      image_version TEXT,
      source_snapshot_id TEXT,
      source_base_generation TEXT,
      target_bundle_version TEXT,
      target_bundle_sha256 TEXT,
      recovery_create_action_id BIGINT,
      recovery_encrypted_payload TEXT,
      recovery_old_server_id BIGINT,
      recovery_old_public_ipv4 TEXT,
      server_type TEXT,
      location TEXT,
      registration_token_hash TEXT,
      registration_token_expires_at TEXT,
      provisioned_at TEXT NOT NULL,
      last_seen_at TEXT,
      deleted_at TEXT,
      failure_code TEXT,
      failure_at TEXT,
      resize_started_at TEXT,
      resize_target_server_type TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      activation_state TEXT NOT NULL DEFAULT 'authorized',
      prebilling_intent_id TEXT,
      activation_authorized_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS runtime_slot TEXT NOT NULL DEFAULT 'primary'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS runtime_token_epoch INTEGER NOT NULL DEFAULT 1 CHECK (runtime_token_epoch >= 1)`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS provisioning_class TEXT NOT NULL DEFAULT 'customer'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS access_clerk_user_ids TEXT[] NOT NULL DEFAULT '{}'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS source_snapshot_id TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS source_base_generation TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS target_bundle_version TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS target_bundle_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_create_action_id BIGINT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_encrypted_payload TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_old_server_id BIGINT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS recovery_old_public_ipv4 TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS server_type TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS location TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS resize_started_at TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS resize_target_server_type TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS activation_state TEXT NOT NULL DEFAULT 'authorized'`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS prebilling_intent_id TEXT`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS activation_authorized_at TEXT`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_active_prebilling_intent ON user_machines(prebilling_intent_id) WHERE prebilling_intent_id IS NOT NULL AND deleted_at IS NULL`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_prebilling_intent`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_status ON user_machines(status)`.execute(db);
  await sql`ALTER TABLE user_machines DROP CONSTRAINT IF EXISTS user_machines_clerk_user_id_key`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_clerk`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_clerk_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_clerk_slot_active
    ON user_machines(clerk_user_id, runtime_slot)
    WHERE deleted_at IS NULL
  `.execute(db);
  // A Matrix login can own more than one active VPS slot. Slot-qualified
  // routing selects the requested runtime; unqualified handle routing resolves
  // deterministically to primary first in the read helpers below.
  await sql`DROP INDEX IF EXISTS idx_user_machines_handle_active`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_handle_slot_active
    ON user_machines(handle, runtime_slot)
    WHERE deleted_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_clerk_slot_status ON user_machines(clerk_user_id, runtime_slot, status)`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_machines_preview_access
    ON user_machines USING GIN(access_clerk_user_ids)
    WHERE deleted_at IS NULL AND provisioning_class = 'preview'
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_hetzner ON user_machines(hetzner_server_id)`.execute(db);
}
