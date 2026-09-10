import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Platform-owned speech admission metadata. Transcript and audio content are never persisted here. */
export async function migrateSpeech(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE ai_runtime_credentials DROP CONSTRAINT IF EXISTS ai_runtime_credentials_audience_check`.execute(db);
  await sql`ALTER TABLE ai_runtime_credentials DROP CONSTRAINT IF EXISTS ai_runtime_credentials_scope_check`.execute(db);
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE ai_runtime_credentials
          ADD CONSTRAINT ai_runtime_credentials_audience_v2_check
          CHECK (audience IN ('matrix-funded-relay', 'matrix-platform-speech'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
      BEGIN
        ALTER TABLE ai_runtime_credentials
          ADD CONSTRAINT ai_runtime_credentials_scope_v2_check
          CHECK (scope IN ('ai:invoke', 'speech:transcribe'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS speech_operations (
      owner_id TEXT NOT NULL,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE ON DELETE CASCADE,
      runtime_slot TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      source_kind TEXT CHECK (source_kind IN ('dictation', 'owner_audio')),
      content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR length(content_fingerprint) = 64),
      policy_revision TEXT,
      adapter_id TEXT,
      model_id TEXT,
      funding_reservation_id TEXT,
      execution_state TEXT NOT NULL CHECK (execution_state IN (
        'received', 'reserved', 'dispatching', 'succeeded', 'failed', 'uncertain', 'cancelled'
      )),
      cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
      tombstone BOOLEAN NOT NULL DEFAULT FALSE,
      dispatch_claimed_at TEXT,
      safe_outcome_code TEXT CHECK (safe_outcome_code IS NULL OR safe_outcome_code IN (
        'transcript', 'no_speech', 'invalid_media', 'timeout', 'provider_failure', 'cancelled'
      )),
      audio_duration_ms BIGINT CHECK (audio_duration_ms IS NULL OR audio_duration_ms > 0),
      reserved_microusd BIGINT CHECK (reserved_microusd IS NULL OR reserved_microusd >= 0),
      actual_microusd BIGINT CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, machine_id, runtime_slot, operation_id),
      CONSTRAINT speech_operation_tombstone_shape CHECK (
        tombstone = FALSE OR (
          execution_state = 'cancelled'
          AND source_kind IS NULL
          AND content_fingerprint IS NULL
          AND funding_reservation_id IS NULL
        )
      ),
      CONSTRAINT speech_operation_lifecycle_shape CHECK (
        (
          execution_state IN ('received', 'reserved')
          AND cancellation_requested = FALSE
          AND dispatch_claimed_at IS NULL
          AND safe_outcome_code IS NULL
        )
        OR (
          execution_state = 'dispatching'
          AND dispatch_claimed_at IS NOT NULL
          AND safe_outcome_code IS NULL
        )
        OR (
          execution_state = 'succeeded'
          AND dispatch_claimed_at IS NOT NULL
          AND safe_outcome_code IS NOT NULL
          AND safe_outcome_code IN ('transcript', 'no_speech')
        )
        OR (
          execution_state = 'failed'
          AND dispatch_claimed_at IS NOT NULL
          AND safe_outcome_code IS NOT NULL
          AND safe_outcome_code IN ('invalid_media', 'timeout', 'provider_failure')
        )
        OR (
          execution_state = 'uncertain'
          AND dispatch_claimed_at IS NOT NULL
          AND safe_outcome_code IS NOT NULL
          AND safe_outcome_code IN ('timeout', 'provider_failure', 'cancelled')
          AND (safe_outcome_code <> 'cancelled' OR cancellation_requested = TRUE)
        )
        OR (
          execution_state = 'cancelled'
          AND cancellation_requested = TRUE
          AND dispatch_claimed_at IS NULL
          AND safe_outcome_code IS NOT NULL
          AND safe_outcome_code = 'cancelled'
        )
      )
    )
  `.execute(db);
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE speech_operations
          ADD CONSTRAINT speech_operation_lifecycle_shape CHECK (
            (
              execution_state IN ('received', 'reserved')
              AND cancellation_requested = FALSE
              AND dispatch_claimed_at IS NULL
              AND safe_outcome_code IS NULL
            )
            OR (
              execution_state = 'dispatching'
              AND dispatch_claimed_at IS NOT NULL
              AND safe_outcome_code IS NULL
            )
            OR (
              execution_state = 'succeeded'
              AND dispatch_claimed_at IS NOT NULL
              AND safe_outcome_code IS NOT NULL
              AND safe_outcome_code IN ('transcript', 'no_speech')
            )
            OR (
              execution_state = 'failed'
              AND dispatch_claimed_at IS NOT NULL
              AND safe_outcome_code IS NOT NULL
              AND safe_outcome_code IN ('invalid_media', 'timeout', 'provider_failure')
            )
            OR (
              execution_state = 'uncertain'
              AND dispatch_claimed_at IS NOT NULL
              AND safe_outcome_code IS NOT NULL
              AND safe_outcome_code IN ('timeout', 'provider_failure', 'cancelled')
              AND (safe_outcome_code <> 'cancelled' OR cancellation_requested = TRUE)
            )
            OR (
              execution_state = 'cancelled'
              AND cancellation_requested = TRUE
              AND dispatch_claimed_at IS NULL
              AND safe_outcome_code IS NOT NULL
              AND safe_outcome_code = 'cancelled'
            )
          ) NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
    END $$
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_speech_operations_active
    ON speech_operations(machine_id, runtime_slot, execution_state, expires_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_speech_operations_expiry
    ON speech_operations(expires_at, execution_state)
  `.execute(db);
}
