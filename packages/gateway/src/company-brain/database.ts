import type { CollaborationDatabase } from "../collaboration/database.js";
import { sql, type ColumnType, type Generated, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
export interface CompanyBrainScopesTable {
  scope_id: string;
  organization_id: string;
  owner_id: string;
  resource_kind: string;
  resource_id: string;
  created_at: Timestamp;
}
export interface CompanyBrainDocumentsTable {
  scope_id: string;
  source_id: string;
  incarnation: Generated<string>;
  title: string;
  text: string;
  permalink: string;
  source_updated_at: Timestamp;
  published_at: Timestamp;
  updated_at: Timestamp;
  revision: number;
  byte_count: number;
  provenance: "manually_published" | "slack_thread";
  deleted_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>;
}
export interface CompanyBrainDatabase extends CollaborationDatabase {
  company_brain_scopes: CompanyBrainScopesTable;
  company_brain_documents: CompanyBrainDocumentsTable;
}

/** Additive owner-Postgres schema. The caller owns the pool and its shutdown. */
export async function bootstrapCompanyBrainDatabase(db: Kysely<CompanyBrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    // Serialize concurrent boots; CREATE IF NOT EXISTS alone races on PostgreSQL catalogs.
    await sql`SELECT pg_advisory_xact_lock(219784012)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS company_brain_scopes (
      scope_id uuid PRIMARY KEY,
      organization_id text NOT NULL,
      owner_id text NOT NULL,
      resource_kind text NOT NULL,
      resource_id text NOT NULL,
      created_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS company_brain_documents (
      scope_id uuid NOT NULL REFERENCES company_brain_scopes(scope_id) ON DELETE CASCADE,
      source_id text NOT NULL CHECK (source_id ~ '^[a-f0-9]{64}$'),
      incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
      title text NOT NULL,
      text text NOT NULL,
      permalink text NOT NULL,
      source_updated_at timestamptz NOT NULL,
      published_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      byte_count integer NOT NULL CHECK (byte_count >= 0 AND byte_count <= 65536),
      provenance text NOT NULL CHECK (provenance IN ('manually_published', 'slack_thread')),
      deleted_at timestamptz,
      PRIMARY KEY (scope_id, source_id)
    )`.execute(trx);
    await sql`ALTER TABLE company_brain_documents ADD COLUMN IF NOT EXISTS incarnation uuid DEFAULT gen_random_uuid()`.execute(trx);
    await sql`UPDATE company_brain_documents SET incarnation = gen_random_uuid() WHERE incarnation IS NULL`.execute(trx);
    await sql`ALTER TABLE company_brain_documents ALTER COLUMN incarnation SET DEFAULT gen_random_uuid()`.execute(trx);
    await sql`ALTER TABLE company_brain_documents ALTER COLUMN incarnation SET NOT NULL`.execute(trx);
    await sql`ALTER TABLE company_brain_documents DROP CONSTRAINT IF EXISTS company_brain_documents_provenance_check`.execute(trx);
    await sql`ALTER TABLE company_brain_documents ADD CONSTRAINT company_brain_documents_provenance_check CHECK (provenance IN ('manually_published', 'slack_thread'))`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS company_brain_documents_search
      ON company_brain_documents USING gin (to_tsvector('english', title || ' ' || text))
      WHERE deleted_at IS NULL`.execute(trx);
  });
}
