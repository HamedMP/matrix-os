import { sql } from "kysely";
import { migratePlatformSchema, type PlatformMigrationExecutor } from "../../../packages/platform/src/database/migrate.js";

/** aff9984698's schema differs from the merged candidate only by these funded
 * additions and the removed preview-drive registration. Reconstruct that
 * predecessor in a disposable test DB; never run this fixture on a live DB. */
export async function migrateGenerationSeven(db: PlatformMigrationExecutor): Promise<void> {
  await migratePlatformSchema(db);
  // Credit history indexes arrived in generation 12, not this predecessor.
  await sql`DROP INDEX idx_ai_funded_ledger_history_cursor`.execute(db);
  await sql`DROP INDEX idx_ai_funded_ledger_history_page`.execute(db);
  await sql`DROP TABLE ai_funded_priority_claims`.execute(db);
  await sql`ALTER TABLE ai_runtime_credentials DROP COLUMN request_class`.execute(db);
  await sql`ALTER TABLE ai_funded_runtime_policies DROP COLUMN next_background_issue_at`.execute(db);
  // Verbatim predecessor preview-drive DDL, retained for compatibility evidence.
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
  await sql`CREATE INDEX IF NOT EXISTS idx_preview_drive_grants_expiry ON preview_drive_grants (expires_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_preview_drive_grants_run ON preview_drive_grants (run_token_hash)`.execute(db);
}
