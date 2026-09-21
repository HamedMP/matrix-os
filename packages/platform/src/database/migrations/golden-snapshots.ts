import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateGoldenSnapshots(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      bundle_version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      bundle_sha256 TEXT NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
      source_git_commit TEXT NOT NULL,
      compatibility_key TEXT NOT NULL CHECK (compatibility_key ~ '^[a-f0-9]{64}$'),
      provider TEXT NOT NULL,
      architecture TEXT NOT NULL,
      region TEXT NOT NULL,
      base_image TEXT NOT NULL,
      base_generation TEXT NOT NULL,
      boot_mode TEXT NOT NULL,
      activation_abi TEXT NOT NULL,
      minimum_disk_gb INTEGER NOT NULL CHECK (minimum_disk_gb > 0),
      test_mode BOOLEAN NOT NULL DEFAULT FALSE,
      image_generation INTEGER NOT NULL DEFAULT 1 CHECK (image_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('candidate', 'building', 'sanitizing', 'validating', 'ready', 'failed', 'quarantined', 'retiring', 'deleted')),
      provider_image_id BIGINT,
      provider_image_status TEXT,
      image_disk_gb INTEGER CHECK (image_disk_gb IS NULL OR image_disk_gb > 0),
      image_architecture TEXT,
      validation_summary JSONB,
      failure_code TEXT,
      ready_at TEXT,
      quarantined_at TEXT,
      retiring_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      UNIQUE (bundle_sha256, compatibility_key, test_mode, image_generation),
      UNIQUE (provider_image_id)
    )
  `.execute(db);
  await sql`ALTER TABLE golden_snapshots ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT FALSE`.execute(db);
  await sql`ALTER TABLE golden_snapshots ADD COLUMN IF NOT EXISTS image_generation INTEGER NOT NULL DEFAULT 1 CHECK (image_generation > 0)`.execute(db);
  await sql`ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_bundle_sha256_compatibility_key_key`.execute(db);
  await sql`ALTER TABLE golden_snapshots DROP CONSTRAINT IF EXISTS golden_snapshots_bundle_sha256_compatibility_key_test_mode_key`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_golden_snapshots_identity`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshots_identity
    ON golden_snapshots(bundle_sha256, compatibility_key, test_mode, image_generation)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshots_selectable
    ON golden_snapshots(compatibility_key, ready_at DESC)
    WHERE state = 'ready'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshots_bundle
    ON golden_snapshots(bundle_version, compatibility_key)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_revoked_base_generations (
      base_generation TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      revoked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_builds (
      build_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL UNIQUE REFERENCES golden_snapshots(snapshot_id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('requested', 'builder_create', 'builder_boot', 'sanitizing', 'snapshot_create', 'snapshot_wait', 'validation_create', 'validation_boot', 'cleanup', 'completed', 'failed', 'reconciling')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      callback_phase TEXT,
      callback_token_hash TEXT,
      callback_expires_at TEXT,
      callback_event_id TEXT,
      callback_payload_sha256 TEXT CHECK (callback_payload_sha256 IS NULL OR callback_payload_sha256 ~ '^[a-f0-9]{64}$'),
      callback_outcome JSONB,
      builder_machine_id_sha256 TEXT CHECK (builder_machine_id_sha256 IS NULL OR builder_machine_id_sha256 ~ '^[a-f0-9]{64}$'),
      builder_ssh_host_key_sha256 TEXT CHECK (builder_ssh_host_key_sha256 IS NULL OR builder_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$'),
      validation_clone_ordinal INTEGER NOT NULL DEFAULT 1 CHECK (validation_clone_ordinal IN (1, 2)),
      first_validation_machine_id_sha256 TEXT CHECK (first_validation_machine_id_sha256 IS NULL OR first_validation_machine_id_sha256 ~ '^[a-f0-9]{64}$'),
      first_validation_ssh_host_key_sha256 TEXT CHECK (first_validation_ssh_host_key_sha256 IS NULL OR first_validation_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$'),
      provider_builder_id BIGINT,
      provider_builder_action_id BIGINT,
      provider_snapshot_action_id BIGINT,
      provider_validation_id BIGINT,
      provider_validation_action_id BIGINT,
      pending_operation TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS builder_machine_id_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS builder_ssh_host_key_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS provider_builder_action_id BIGINT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_event_id TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_payload_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS callback_outcome JSONB
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS validation_clone_ordinal INTEGER NOT NULL DEFAULT 1
    CHECK (validation_clone_ordinal IN (1, 2))
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS first_validation_machine_id_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD COLUMN IF NOT EXISTS first_validation_ssh_host_key_sha256 TEXT
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    DROP CONSTRAINT IF EXISTS golden_snapshot_builds_first_validation_machine_id_sha256_check
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD CONSTRAINT golden_snapshot_builds_first_validation_machine_id_sha256_check
    CHECK (first_validation_machine_id_sha256 IS NULL OR first_validation_machine_id_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    DROP CONSTRAINT IF EXISTS golden_snapshot_builds_first_validation_ssh_host_key_sha256_check
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_builds
    ADD CONSTRAINT golden_snapshot_builds_first_validation_ssh_host_key_sha256_check
    CHECK (first_validation_ssh_host_key_sha256 IS NULL OR first_validation_ssh_host_key_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_builds_dispatch
    ON golden_snapshot_builds(status, available_at, lease_expires_at)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_callback_receipts (
      build_id TEXT NOT NULL REFERENCES golden_snapshot_builds(build_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      callback_phase TEXT NOT NULL CHECK (length(callback_phase) BETWEEN 1 AND 64),
      token_sha256 TEXT CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
      outcome JSONB NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (build_id, event_id)
    )
  `.execute(db);
  await sql`
    ALTER TABLE golden_snapshot_callback_receipts
    ADD COLUMN IF NOT EXISTS token_sha256 TEXT
      CHECK (token_sha256 ~ '^[a-f0-9]{64}$')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_callback_receipts_expiry
    ON golden_snapshot_callback_receipts(expires_at, build_id, event_id)
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_leases (
      lease_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES golden_snapshots(snapshot_id),
      machine_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('provision', 'recover')),
      target_bundle_version TEXT NOT NULL REFERENCES host_bundle_releases(version),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshot_leases_machine_active
    ON golden_snapshot_leases(machine_id)
    WHERE released_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_leases_protection
    ON golden_snapshot_leases(snapshot_id, expires_at)
    WHERE released_at IS NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_rollout_controls (
      compatibility_key TEXT PRIMARY KEY CHECK (compatibility_key ~ '^[a-f0-9]{64}$'),
      enabled BOOLEAN NOT NULL DEFAULT false,
      percentage INTEGER NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
      generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_create_intents (
      intent_id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES golden_snapshots(snapshot_id),
      lease_id TEXT NOT NULL REFERENCES golden_snapshot_leases(lease_id),
      machine_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('provision', 'recover')),
      rollout_generation BIGINT NOT NULL CHECK (rollout_generation >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'denied', 'activated', 'cleaned')),
      provider_create_action_id BIGINT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (lease_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_create_intents_open
    ON golden_snapshot_create_intents(snapshot_id, state)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE provisioning_jobs
    DROP CONSTRAINT IF EXISTS provisioning_jobs_snapshot_create_intent_id_fkey
  `.execute(db);
  await sql`
    ALTER TABLE provisioning_jobs
    ADD CONSTRAINT provisioning_jobs_snapshot_create_intent_id_fkey
    FOREIGN KEY (snapshot_create_intent_id)
    REFERENCES golden_snapshot_create_intents(intent_id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_jobs_snapshot_create_intent
    ON provisioning_jobs(snapshot_create_intent_id)
    WHERE snapshot_create_intent_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_cleanup (
      cleanup_id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES golden_snapshots(snapshot_id),
      build_id TEXT REFERENCES golden_snapshot_builds(build_id),
      resource_type TEXT NOT NULL CHECK (resource_type IN ('builder_server', 'validation_server', 'snapshot_image')),
      provider_resource_id BIGINT NOT NULL CHECK (provider_resource_id > 0),
      provenance_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quarantined')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS golden_snapshot_audit_events (
      event_id TEXT PRIMARY KEY,
      snapshot_id TEXT REFERENCES golden_snapshots(snapshot_id) ON DELETE SET NULL,
      build_id TEXT REFERENCES golden_snapshot_builds(build_id) ON DELETE SET NULL,
      cleanup_id TEXT REFERENCES golden_snapshot_cleanup(cleanup_id) ON DELETE SET NULL,
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('release', 'worker', 'operator')),
      actor_id_hash TEXT CHECK (actor_id_hash IS NULL OR actor_id_hash ~ '^[a-f0-9]{64}$'),
      from_state TEXT,
      to_state TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_audit_events_retention
    ON golden_snapshot_audit_events(created_at, event_id)
  `.execute(db);
  await sql`
    DO $$
    DECLARE
      current_definition TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO current_definition
      FROM pg_constraint
      WHERE conrelid = 'golden_snapshot_cleanup'::regclass
        AND conname = 'golden_snapshot_cleanup_status_check';
      IF current_definition IS NULL OR current_definition NOT LIKE '%quarantined%' THEN
        ALTER TABLE golden_snapshot_cleanup
          DROP CONSTRAINT IF EXISTS golden_snapshot_cleanup_status_check;
        ALTER TABLE golden_snapshot_cleanup
          ADD CONSTRAINT golden_snapshot_cleanup_status_check
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quarantined'));
      END IF;
    END $$
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_golden_snapshot_cleanup_resource_active
    ON golden_snapshot_cleanup(resource_type, provider_resource_id)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_golden_snapshot_cleanup_dispatch
    ON golden_snapshot_cleanup(status, next_attempt_at, lease_expires_at)
    WHERE completed_at IS NULL
  `.execute(db);
}
