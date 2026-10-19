import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Called inside the platform's advisory-locked migration transaction. */
export async function migrateSharedPreviewRuntimes(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF position('shared-preview' IN pg_get_constraintdef((
        SELECT oid FROM pg_constraint WHERE conrelid = 'user_machines'::regclass
        AND conname = 'user_machines_provisioning_class_check'
      ))) = 0 THEN
        ALTER TABLE user_machines DROP CONSTRAINT user_machines_provisioning_class_check;
        ALTER TABLE user_machines ADD CONSTRAINT user_machines_provisioning_class_check
          CHECK (provisioning_class IN ('customer', 'preview', 'private-preview', 'shared-preview')) NOT VALID;
      END IF;
      IF position('shared-preview' IN pg_get_constraintdef((
        SELECT oid FROM pg_constraint WHERE conrelid = 'user_machines'::regclass
        AND conname = 'user_machines_private_preview_check'
      ))) = 0 THEN
        ALTER TABLE user_machines DROP CONSTRAINT user_machines_private_preview_check;
        ALTER TABLE user_machines ADD CONSTRAINT user_machines_private_preview_check CHECK (
          (provisioning_class IN ('private-preview', 'shared-preview')
            AND source_pr BETWEEN 1 AND 999999999 AND source_pr IS NOT NULL
            AND cardinality(access_clerk_user_ids) = 0 AND runtime_slot = handle
            AND ((provisioning_class = 'private-preview' AND handle ~ '^pv-[1-9][0-9]{0,8}-[0-9a-f]{8}$')
              OR (provisioning_class = 'shared-preview' AND handle ~ '^swp-[1-9][0-9]{0,8}-[0-9a-f]{8}$'
                AND hetzner_server_id IS NULL AND public_ipv4 IS NULL AND public_ipv6 IS NULL)))
          OR (provisioning_class NOT IN ('private-preview', 'shared-preview') AND source_pr IS NULL)
        ) NOT VALID;
      END IF;
    END $$
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_preview_owner_pr ON user_machines(clerk_user_id, source_pr)
    WHERE provisioning_class = 'shared-preview' AND deleted_at IS NULL
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS shared_preview_runtime_bindings (
      machine_id TEXT PRIMARY KEY REFERENCES user_machines(machine_id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      source_pr INTEGER NOT NULL CHECK (source_pr BETWEEN 1 AND 999999999),
      worker_origin TEXT NOT NULL UNIQUE CHECK (char_length(worker_origin) BETWEEN 10 AND 2048),
      created_at TEXT NOT NULL,
      UNIQUE (owner_id, source_pr)
    )
  `.execute(db);
}
