import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../database/migration-types.js';

export interface GooglePurchaseTable {
  subscription_id: string; transaction_id: string; clerk_user_id: string;
  payload: string | null; created_at: string; sent_at: string | null;
  attempts: number; available_at: string; lease_until: string | null; lease_token: string | null;
}
export interface GoogleCheckoutAttributionTable {
  attempt_id: string; clerk_user_id: string; payload: string; created_at: string;
}
export async function migrateGooglePurchases(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS billing_google_purchases (
    subscription_id TEXT PRIMARY KEY, transaction_id TEXT UNIQUE NOT NULL, clerk_user_id TEXT NOT NULL,
    payload TEXT, created_at TEXT NOT NULL, sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL, lease_until TEXT, lease_token TEXT
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS billing_google_purchase_delivery ON billing_google_purchases (available_at) WHERE sent_at IS NULL`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS billing_google_checkout_attribution (
    attempt_id TEXT PRIMARY KEY REFERENCES billing_checkout_attempts(id) ON DELETE CASCADE,
    clerk_user_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  )`.execute(db);
}
