import { sql, type Kysely, type QueryExecutorProvider, type Transaction } from "kysely";
import { boundedProvenanceTransaction } from "../provenance/transaction.js";

export async function lockGoogleContexts<DB>(tx: Transaction<DB>) {
  await sql`SELECT pg_advisory_xact_lock(551035504)`.execute(tx);
}
// A host without this schema has never stored Google context markers.
export async function hasGoogleContextMarker(db: QueryExecutorProvider, ownerId: string, chatId: string): Promise<boolean> {
  const schema = (await sql<{ installed: boolean }>`SELECT to_regclass('google_context_markers') IS NOT NULL AS installed`.execute(db)).rows[0];
  if (schema?.installed === false) return false;
  const row = (await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM google_context_markers
    WHERE owner_id=${ownerId} AND chat_id=${chatId}) AS present`.execute(db)).rows[0];
  return row?.present !== false;
}

export async function migrateGoogleContexts<DB>(db: Kysely<DB>) {
  await boundedProvenanceTransaction(db, async tx => {
    await lockGoogleContexts(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_context_sources (
      origin_id TEXT PRIMARY KEY CHECK(origin_id ~ '^[0-9a-f]{64}$'), owner_id TEXT NOT NULL, google_account_id UUID NOT NULL,
      consent_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_revision INTEGER NOT NULL CHECK(profile_revision>0),
      purpose_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','purging')),
      UNIQUE(owner_id,google_account_id,consent_id))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_context_sources_account ON google_context_sources(owner_id,google_account_id)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_context_markers (
      id UUID PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      retention_deadline TIMESTAMPTZ NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','purging','deleted')),
      UNIQUE(owner_id,chat_id))`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_context_origins (
      context_id UUID NOT NULL REFERENCES google_context_markers(id), origin_id TEXT NOT NULL REFERENCES google_context_sources(origin_id),
      PRIMARY KEY(context_id,origin_id))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_context_origin_reverse ON google_context_origins(origin_id,context_id)`.execute(tx);
  });
}
