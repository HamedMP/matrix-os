import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Platform-owned speech admission metadata. Transcript and audio content are never persisted here. */
export async function migrateSpeech(db: PlatformMigrationExecutor): Promise<void> {
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
      )
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_speech_operations_active
    ON speech_operations(machine_id, runtime_slot, execution_state, expires_at)
  `.execute(db);
}
