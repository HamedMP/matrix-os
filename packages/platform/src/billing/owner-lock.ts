import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';

/** Shared by billing admission and reviewed retention; independent of optional deletion config. */
export async function lockBillingOwner(db: PlatformDB, ownerId: string): Promise<void> {
  if (!db.executor.isTransaction) throw new Error('Billing owner lock requires a transaction');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-owner:${ownerId}`}, 0))`.execute(db.executor);
}
