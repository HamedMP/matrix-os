import { customerChargeReleaseBindingSql } from "../../ai-funded-customer-charge-release.js";
import { sql } from "kysely";
import type { PlatformMigrationExecutor } from "../migration-types.js";

/** Additive: old authorizations keep their original hold and source attribution. */
export async function migrateFundedPostpaid(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE ai_funded_usage_reservations ADD COLUMN IF NOT EXISTS customer_charge_release TEXT`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT IF EXISTS ai_funded_usage_reservations_reserved_microusd_check`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_usage_reservations_reserved_microusd_check CHECK (COALESCE(
    (reserved_microusd > 0 AND authorization_response::jsonb #>> '{reservation,billingPolicy}' IS DISTINCT FROM 'postpaid') OR (reserved_microusd = 0
      AND authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'
      AND authorization_response::jsonb #>> '{reservation,billingPolicy}' = 'postpaid'
      AND authorization_response::jsonb #>> '{reservation,reservedMicrousd}' = '0'), FALSE))`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations DROP CONSTRAINT IF EXISTS ai_funded_customer_release_check`.execute(db);
  await sql`ALTER TABLE ai_funded_usage_reservations ADD CONSTRAINT ai_funded_customer_release_check CHECK (
    customer_charge_release IS NULL OR ${customerChargeReleaseBindingSql()})`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_funded_customer_unknown_expense
    ON ai_funded_usage_reservations(owner_id, reservation_id)
    WHERE customer_charge_release IS NOT NULL AND actual_microusd IS NULL`.execute(db);
}
