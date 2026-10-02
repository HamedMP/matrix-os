import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Ephemeral, hashed browser proof redemptions and one-use Drive read grants. */
export async function migratePreviewDrive(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS preview_drive_grants (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('run', 'action')),
      proof_nonce_hash TEXT NOT NULL UNIQUE,
      run_token_hash TEXT,
      handle TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      body_digest TEXT NOT NULL,
      action_digest TEXT,
      account_label TEXT,
      max_results INTEGER,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_preview_drive_grants_expiry
    ON preview_drive_grants (expires_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_preview_drive_grants_run
    ON preview_drive_grants (run_token_hash)
  `.execute(db);
}
