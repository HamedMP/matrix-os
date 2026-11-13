import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "./migration-types.js";

/** Independent additive scope: newer Preview core markers must not skip this table. */
export async function migrateFundedProbeCache(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ai_funded_model_probe_cache (
      cache_key TEXT PRIMARY KEY CHECK (cache_key ~ '^[a-f0-9]{64}$'),
      lease_token UUID NOT NULL,
      lease_until TIMESTAMPTZ NOT NULL,
      ready BOOLEAN,
      checked_ms BIGINT,
      stale_ms BIGINT,
      price_expiry_ms BIGINT
    )
  `.execute(db);
  await sql`
    ALTER TABLE ai_funded_model_probe_cache
      ADD COLUMN IF NOT EXISTS regular_after_ms BIGINT NOT NULL DEFAULT 0 CHECK (regular_after_ms >= 0),
      ADD COLUMN IF NOT EXISTS failure_streak INTEGER NOT NULL DEFAULT 0 CHECK (failure_streak BETWEEN 0 AND 3),
      DROP CONSTRAINT IF EXISTS ai_funded_model_probe_cache_check,
      DROP CONSTRAINT IF EXISTS ai_funded_model_probe_cache_receipt_check
  `.execute(db);
  await sql`
    ALTER TABLE ai_funded_model_probe_cache ADD CONSTRAINT ai_funded_model_probe_cache_receipt_check
      CHECK ((ready IS NULL AND checked_ms IS NULL AND stale_ms IS NULL AND price_expiry_ms IS NULL)
        OR (ready IS NOT NULL AND checked_ms IS NOT NULL AND stale_ms IS NOT NULL
          AND stale_ms > checked_ms AND stale_ms <= checked_ms + 900000
          AND ((ready AND price_expiry_ms IS NOT NULL AND price_expiry_ms >= stale_ms)
            OR (NOT ready AND price_expiry_ms IS NULL))))
  `.execute(db);
  // Separate retry bucket stamps preserve both counters through mixed-version UTC rollover.
  await sql`
    ALTER TABLE ai_funded_model_probe_budget
      ADD COLUMN IF NOT EXISTS retry_day_start TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS retry_day_used INTEGER NOT NULL DEFAULT 0 CHECK (retry_day_used >= 0),
      ADD COLUMN IF NOT EXISTS retry_minute_start TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS retry_minute_used INTEGER NOT NULL DEFAULT 0 CHECK (retry_minute_used >= 0)
  `.execute(db);
}
