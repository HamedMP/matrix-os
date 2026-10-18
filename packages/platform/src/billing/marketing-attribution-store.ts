import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';
import type { MarketingAttribution } from './checkout-schemas.js';

export interface MarketingCheckoutAttributionTable {
  attempt_id: string;
  clerk_user_id: string;
  payload: string;
  created_at: string;
}

export async function migrateMarketingAttribution(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS billing_marketing_checkout_attribution (
    attempt_id TEXT PRIMARY KEY REFERENCES billing_checkout_attempts(id) ON DELETE CASCADE,
    clerk_user_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS billing_marketing_attribution_created_at
    ON billing_marketing_checkout_attribution (created_at)`.execute(db);
}

/** Keep even absence immutable so an ambiguous Stripe retry uses identical parameters. */
export async function rememberMarketingAttribution(
  db: PlatformDB, attemptId: string, owner: string,
  attribution: MarketingAttribution | undefined, at: string,
): Promise<MarketingAttribution | undefined> {
  return db.transaction(async trx => {
    await trx.executor.insertInto('billing_marketing_checkout_attribution').values({
      attempt_id: attemptId, clerk_user_id: owner,
      payload: JSON.stringify(attribution ?? null), created_at: at,
    }).onConflict(oc => oc.column('attempt_id').doNothing()).execute();
    const snapshot = await trx.executor.selectFrom('billing_marketing_checkout_attribution')
      .select(['clerk_user_id', 'payload']).where('attempt_id', '=', attemptId).executeTakeFirstOrThrow();
    if (snapshot.clerk_user_id !== owner) throw new Error('Checkout attribution owner mismatch');
    // Only schema-validated request values are written; do not re-evaluate expiry on retries.
    return (JSON.parse(snapshot.payload) as MarketingAttribution | null) ?? undefined;
  });
}
