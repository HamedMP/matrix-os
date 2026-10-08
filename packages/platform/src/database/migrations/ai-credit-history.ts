import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";

/** Preserve opaque cursors while bounding anchor and stable-order page reads. */
export async function migrateAiCreditHistory(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_ledger_history_cursor
    ON ai_funded_credit_ledger (
      owner_id, machine_id, runtime_slot,
      (md5(entry_id || ':' || owner_id || ':' || machine_id || ':' || runtime_slot))
    ) INCLUDE (entry_id, created_at)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_ledger_history_page
    ON ai_funded_credit_ledger (owner_id, machine_id, runtime_slot, created_at DESC, entry_id DESC)
  `.execute(db);
}
