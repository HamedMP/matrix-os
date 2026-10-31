/**
 * Company Brain store schema. One idempotent bootstrap creates the nine
 * brain_* tables (three created by claims/database.ts) and their indexes
 * under a schema-wide advisory lock so concurrent gateway processes cannot
 * race CREATE TABLE IF NOT EXISTS.
 * Future changes are appended here as ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS + backfill + SET NOT NULL, the same way chat/database.ts evolves.
 */
import { sql, type Kysely } from "kysely";
import { createBrainClaimTables } from "./claims/database.js";
import type { BrainDatabase } from "./types.js";

export async function bootstrapBrainDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    // Serialize schema creation across Gateway processes sharing this schema.
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('brain_schema'))`.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_sources (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
        external_ref TEXT NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 512),
        label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 300),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ,
        PRIMARY KEY (owner_id, scope_id, source_id)
      )
    `.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_documents (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
        source_id TEXT CHECK (source_id IS NULL OR source_id ~ '^src_[a-f0-9]{32}$'),
        incarnation UUID NOT NULL,
        title TEXT NOT NULL CHECK (char_length(title) <= 300),
        body TEXT NOT NULL CHECK (octet_length(body) <= 65536),
        permalink TEXT NOT NULL CHECK (char_length(permalink) <= 2048),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 65536),
        provenance TEXT NOT NULL CHECK (provenance ~ '^[a-z][a-z0-9_]{0,31}$'),
        revision INTEGER NOT NULL CHECK (revision > 0),
        source_updated_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ,
        PRIMARY KEY (owner_id, scope_id, document_id),
        CHECK (deleted_at IS NULL OR (title = '' AND body = '' AND permalink = '' AND byte_count = 0)),
        CHECK (deleted_at IS NOT NULL OR (char_length(title) >= 1 AND char_length(body) >= 1))
      )
    `.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_document_revisions (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
        source_id TEXT CHECK (source_id IS NULL OR source_id ~ '^src_[a-f0-9]{32}$'),
        incarnation UUID NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        change TEXT NOT NULL CHECK (change IN ('updated', 'deleted')),
        title TEXT NOT NULL CHECK (char_length(title) <= 300),
        body TEXT NOT NULL CHECK (octet_length(body) <= 65536),
        permalink TEXT NOT NULL CHECK (char_length(permalink) <= 2048),
        content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 65536),
        provenance TEXT NOT NULL CHECK (provenance ~ '^[a-z][a-z0-9_]{0,31}$'),
        source_updated_at TIMESTAMPTZ NOT NULL,
        superseded_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, document_id, incarnation, revision)
      )
    `.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_sync_cursors (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        cursor TEXT NOT NULL CHECK (char_length(cursor) BETWEEN 1 AND 2048),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, source_id),
        FOREIGN KEY (owner_id, scope_id, source_id)
          REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE
      )
    `.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_sync_receipts (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        receipt_id TEXT NOT NULL CHECK (receipt_id ~ '^rcp_[a-f0-9]{32}$'),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'interrupted')),
        read_count INTEGER NOT NULL DEFAULT 0 CHECK (read_count >= 0),
        written_count INTEGER NOT NULL DEFAULT 0 CHECK (written_count >= 0),
        unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
        deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
        failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
        next_action TEXT NOT NULL DEFAULT ''
          CHECK (char_length(next_action) <= 500 AND next_action ~ '^([a-z][a-z0-9_]*)?$'),
        error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
        cursor_before TEXT CHECK (cursor_before IS NULL OR char_length(cursor_before) BETWEEN 1 AND 2048),
        cursor_after TEXT CHECK (cursor_after IS NULL OR char_length(cursor_after) BETWEEN 1 AND 2048),
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        PRIMARY KEY (owner_id, scope_id, source_id, receipt_id),
        FOREIGN KEY (owner_id, scope_id, source_id)
          REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE,
        CHECK ((status = 'running') = (finished_at IS NULL))
      )
    `.execute(trx);

    // Only live documents have refs: every tombstone path deletes them and
    // eraseScope deletes them first. The "C" collation makes value order
    // bytewise, so a directory prefix is an index range scan.
    await sql`
      CREATE TABLE IF NOT EXISTS brain_document_refs (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
        kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
        value TEXT COLLATE "C" NOT NULL CHECK (octet_length(value) BETWEEN 1 AND 512),
        PRIMARY KEY (owner_id, scope_id, document_id, kind, value),
        FOREIGN KEY (owner_id, scope_id, document_id)
          REFERENCES brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE
      )
    `.execute(trx);

    // Live natural key per scope; a tombstoned source frees (kind, external_ref) for reuse.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS brain_sources_live_ref
      ON brain_sources (owner_id, scope_id, kind, external_ref) WHERE deleted_at IS NULL
    `.execute(trx);
    // Plain full-text index over live documents; 'simple' is language-neutral (chat/database.ts convention).
    await sql`
      CREATE INDEX IF NOT EXISTS brain_documents_search
      ON brain_documents USING GIN (to_tsvector('simple', title || ' ' || body)) WHERE deleted_at IS NULL
    `.execute(trx);
    await sql`
      CREATE INDEX IF NOT EXISTS brain_documents_source
      ON brain_documents (owner_id, scope_id, source_id, document_id) WHERE deleted_at IS NULL
    `.execute(trx);
    // listDocumentsByRef: newest source_updated_at first with a (timestamp, id) keyset.
    await sql`
      CREATE INDEX IF NOT EXISTS brain_documents_recent
      ON brain_documents (owner_id, scope_id, source_updated_at DESC, document_id DESC) WHERE deleted_at IS NULL
    `.execute(trx);
    await sql`
      CREATE INDEX IF NOT EXISTS brain_sync_receipts_started
      ON brain_sync_receipts (owner_id, scope_id, source_id, started_at DESC)
    `.execute(trx);
    await sql`
      CREATE INDEX IF NOT EXISTS brain_document_refs_lookup
      ON brain_document_refs (owner_id, scope_id, kind, value)
    `.execute(trx);
    // Claim tables reference brain_documents, so they come last.
    await createBrainClaimTables(trx);
  });
}
