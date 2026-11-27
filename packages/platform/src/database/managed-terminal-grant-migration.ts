import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "./migration-types.js";

export const MANAGED_TERMINAL_GRANT_REVISION = { generation: 1, fingerprint: "managed-terminal-grant-claims-v1" } as const;

/** Short-lived owner grants have a separate revision from core rollout data. */
export async function migrateManagedTerminalGrants(db: PlatformMigrationExecutor) {
  await sql`
    CREATE TABLE IF NOT EXISTS managed_terminal_grant_claims (
      turn_hash TEXT PRIMARY KEY,
      run_hash TEXT NOT NULL UNIQUE,
      nonce_hash TEXT UNIQUE,
      selection_hash TEXT,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_managed_terminal_grant_claims_expiry
    ON managed_terminal_grant_claims (expires_at)
  `.execute(db);
}
