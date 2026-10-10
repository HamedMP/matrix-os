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
      price_expiry_ms BIGINT,
      CHECK ((ready IS NULL AND checked_ms IS NULL AND stale_ms IS NULL AND price_expiry_ms IS NULL)
        OR (ready IS NOT NULL AND checked_ms IS NOT NULL AND stale_ms IS NOT NULL
          AND stale_ms > checked_ms AND stale_ms <= checked_ms + CASE WHEN ready THEN 300000 ELSE 5000 END
          AND ((ready AND price_expiry_ms IS NOT NULL AND price_expiry_ms >= stale_ms)
            OR (NOT ready AND price_expiry_ms IS NULL))))
    )
  `.execute(db);
}
