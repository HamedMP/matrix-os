import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "./migration-types.js";

/** An independent scope keeps the registry available alongside newer Preview core schemas. */
export async function migrateAiFundedPricing(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_pricing_reviews (
      model_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL,
      valid_through TIMESTAMPTZ NOT NULL,
      source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
      blocked_at TIMESTAMPTZ,
      CHECK (valid_through > reviewed_at OR
        (valid_through = reviewed_at AND blocked_at IS NOT NULL AND blocked_at <= reviewed_at))
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_pricing_review_history (
      evidence_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      version TEXT NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL,
      valid_through TIMESTAMPTZ NOT NULL,
      source_digest TEXT NOT NULL,
      blocked_at TIMESTAMPTZ,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_pricing_job_state (
      kind TEXT PRIMARY KEY CHECK (kind IN ('review', 'watchdog')),
      lease_id TEXT,
      lease_until TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ NOT NULL,
      first_claimed_at TIMESTAMPTZ NOT NULL,
      last_successful_at TIMESTAMPTZ
    )
  `.execute(db);
}
