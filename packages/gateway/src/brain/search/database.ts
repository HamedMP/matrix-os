/**
 * Search tables: one idempotent bootstrap under the brain_search_schema lock. brain_search_vectors (plain real[]
 * vectors) always exists; brain_search_chunks exists only when `CREATE EXTENSION IF NOT EXISTS vector` succeeds; a
 * missing extension or missing privilege is reported, never fatal.
 * Every table references brain_documents only (never brain_claims), so a search write never locks a claim row.
 * Future changes: ADD COLUMN IF NOT EXISTS here.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import { BRAIN_FEATURE_SCHEMA_LOCKS, type BrainSearchCapabilityView } from "../contracts.js";
import type { BrainDatabase } from "../types.js";
import { sqlState } from "./types.js";

/** feature_not_supported (extension not available, PG 15+), undefined_file (older), insufficient_privilege. */
const EXTENSION_UNAVAILABLE_CODES: ReadonlySet<unknown> = new Set(["0A000", "58P01", "42501"]);

const OWNER_SCOPE = sql.raw(`
  owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
  scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
  document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$')`);

/** Added in place, so tables made before it get it too: the chunk text's key (null: never reused). */
const addTextKey = (trx: Transaction<BrainDatabase>, table: "brain_search_chunks" | "brain_search_vectors") => sql`
  ALTER TABLE ${sql.table(table)}
  ADD COLUMN IF NOT EXISTS text_key TEXT CHECK (text_key IS NULL OR text_key ~ '^[a-f0-9]{32}$')`.execute(trx);

const DOCUMENT_FK = sql.raw(`FOREIGN KEY (owner_id, scope_id, document_id)
  REFERENCES brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE`);

async function createTextTables(trx: Transaction<BrainDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS brain_search_documents (
      ${OWNER_SCOPE},
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      claims_key TEXT NOT NULL CHECK (claims_key ~ '^[a-f0-9]{32}$'),
      embedded_provider TEXT CHECK (embedded_provider IS NULL
        OR embedded_provider ~ '^[a-z0-9][a-z0-9._:/-]{0,72}$'),
      embed_failed_at TIMESTAMPTZ,
      tsv TSVECTOR NOT NULL,
      indexed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, scope_id, document_id),
      ${DOCUMENT_FK}
    )
  `.execute(trx);
  await sql`
    CREATE TABLE IF NOT EXISTS brain_search_claims (
      ${OWNER_SCOPE},
      claim_id TEXT NOT NULL CHECK (claim_id ~ '^[a-f0-9]{64}$'),
      extractor TEXT NOT NULL CHECK (char_length(extractor) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind IN ('invariant', 'decision', 'commitment', 'risk')),
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      tsv TSVECTOR NOT NULL,
      PRIMARY KEY (owner_id, scope_id, claim_id, extractor),
      ${DOCUMENT_FK}
    )
  `.execute(trx);
  for (const index of [
    "INDEX IF NOT EXISTS brain_search_documents_tsv ON brain_search_documents USING GIN (tsv)",
    "INDEX IF NOT EXISTS brain_search_claims_tsv ON brain_search_claims USING GIN (tsv)",
    "INDEX IF NOT EXISTS brain_search_claims_document ON brain_search_claims (owner_id, scope_id, document_id)",
  ]) await sql.raw(`CREATE ${index}`).execute(trx);
}

/**
 * Unit vectors as float4 arrays: the CHECK refuses another length, more than one dimension, NULL, NaN, infinities and
 * values past unit length (with float4 rounding room).
 */
async function createVectorsTable(trx: Transaction<BrainDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS brain_search_vectors (
      ${OWNER_SCOPE},
      chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 39),
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._:/-]{0,63}$'),
      dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
      embedding REAL[] NOT NULL CHECK (array_ndims(embedding) = 1 AND cardinality(embedding) = dimensions
        AND array_position(embedding, NULL) IS NULL
        AND 1.0001::real >= ALL (embedding) AND -1.0001::real <= ALL (embedding)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, scope_id, document_id, chunk_index),
      ${DOCUMENT_FK}
    )
  `.execute(trx);
  await addTextKey(trx, "brain_search_vectors");
}

async function createChunksTable(trx: Transaction<BrainDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS brain_search_chunks (
      ${OWNER_SCOPE},
      chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 39),
      incarnation UUID NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._:/-]{0,63}$'),
      span_start INTEGER NOT NULL CHECK (span_start >= 0),
      span_end INTEGER NOT NULL CHECK (span_end <= 65536 AND span_end > span_start),
      dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
      embedding vector NOT NULL CHECK (vector_dims(embedding) = dimensions),
      PRIMARY KEY (owner_id, scope_id, document_id, chunk_index),
      ${DOCUMENT_FK}
    )
  `.execute(trx);
  await sql`
    CREATE INDEX IF NOT EXISTS brain_search_chunks_provider
    ON brain_search_chunks (owner_id, scope_id, provider_id, dimensions)
  `.execute(trx);
  await addTextKey(trx, "brain_search_chunks");
}

/** True when the extension is (now) installed; a savepoint keeps the transaction usable when it is not. */
async function enableVector(trx: Transaction<BrainDatabase>): Promise<boolean> {
  await sql`SAVEPOINT brain_search_vector`.execute(trx);
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(trx);
  } catch (error: unknown) {
    if (!EXTENSION_UNAVAILABLE_CODES.has(sqlState(error))) throw error;
    await sql`ROLLBACK TO SAVEPOINT brain_search_vector`.execute(trx);
    console.warn("[brain-search] pgvector unavailable, full-text search only:", sqlState(error));
    return false;
  }
  await sql`RELEASE SAVEPOINT brain_search_vector`.execute(trx);
  return true;
}

/** Creates the search tables (chunks too with pgvector); never "available", which needs createBrainSearch's provider. */
export async function bootstrapBrainSearchDatabase(db: Kysely<BrainDatabase>): Promise<BrainSearchCapabilityView> {
  const vector = await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.search}))`
      .execute(trx);
    await createTextTables(trx);
    await createVectorsTable(trx);
    const enabled = await enableVector(trx);
    if (enabled) await createChunksTable(trx);
    return enabled;
  });
  return { fullText: true, vector: vector ? "provider_not_configured" : "extension_missing", providerId: null };
}
