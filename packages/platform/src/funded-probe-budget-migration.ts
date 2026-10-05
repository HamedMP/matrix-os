import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "./database/migration-types.js";

/** Additive feature migration; independent of the core generation so old
 * preview branches can share a newer staging schema without downgrading it. */
export async function migrateFundedProbeBudget(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE ai_funded_model_probe_budget DROP CONSTRAINT IF EXISTS ai_funded_model_probe_budget_budget_key_check`.execute(db);
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_funded_probe_budget_scope_check'
      AND conrelid = 'ai_funded_model_probe_budget'::regclass) THEN
      ALTER TABLE ai_funded_model_probe_budget ADD CONSTRAINT ai_funded_probe_budget_scope_check
        CHECK (budget_key = 'global' OR (length(budget_key) <= 64 AND budget_key ~ '^preview-[a-z0-9][a-z0-9-]*$'));
    END IF;
  END $$`.execute(db);
}
