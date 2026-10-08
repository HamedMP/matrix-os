/**
 * SQL of the search index: pending documents, orphans, the batched rebuild (text vectors computed by Postgres in the
 * statement that records their (incarnation, revision)) and scope erase. Every statement carries (owner_id,
 * scope_id); the core tables are only read.
 */
import { sql, type Kysely, type QueryExecutorProvider, type Transaction } from "kysely";
import { BRAIN_FEATURE_SCOPE_LOCK_PREFIXES, BRAIN_SEARCH_CHUNK } from "../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { BRAIN_SEARCH_STATEMENT_TIMEOUT_MS, type BrainSearchEmbedTarget, type SqlFragment } from "./types.js";

/** md5 over the document's claims as they are indexed: id, extractor, incarnation, revision and spans. */
const CLAIMS_KEY = sql`(SELECT md5(coalesce(string_agg(
    c.claim_id || '/' || c.extractor || '/' || c.incarnation::text || '/' || c.revision::text || '/'
      || c.span_start::text || '/' || c.span_end::text, ',' ORDER BY c.claim_id, c.extractor), ''))
  FROM brain_claims c
  WHERE c.owner_id = d.owner_id AND c.scope_id = d.scope_id AND c.document_id = d.document_id)`;

const idsFilter = (column: string, ids: readonly string[] | null): SqlFragment =>
  ids === null ? sql`` : sql` AND ${sql.ref(column)} IN (${sql.join([...ids])})`;

/** A document id with the (incarnation, revision) a row was built from or is about. */
export interface BrainSearchOrphan { readonly documentId: string; readonly incarnation: string; readonly revision: number }
/** A row to embed, with the claims set it was built from: a claims change keeps the revision but not this key. */
export interface BrainSearchEmbedCandidate extends BrainSearchOrphan { readonly claimsKey: string }
type BuiltRow = { document_id: string; incarnation: string; revision: number };
const asBuilt = (rows: readonly BuiltRow[]): BrainSearchOrphan[] =>
  rows.map((row) => ({ documentId: row.document_id, incarnation: row.incarnation, revision: row.revision }));

/** Document `d` is of a provenance the embed target may send (none when its list is empty). */
const sendable = (embed: BrainSearchEmbedTarget): SqlFragment => (embed.provenances.length === 0 ? sql`FALSE`
  : sql`d.provenance IN (${sql.join([...embed.provenances])})`);

/**
 * Live documents with no row, a row of another (incarnation, revision) or claims set, or (embed target given) of a
 * provenance it may send and not embedded under its marker.
 */
function pendingFrom(
  scope: BrainScopeKey, embed: BrainSearchEmbedTarget | null, ids: readonly string[] | null,
): SqlFragment {
  const embedded = embed === null ? sql``
    : sql` OR (s.embedded_provider IS DISTINCT FROM ${embed.marker} AND ${sendable(embed)})`;
  return sql`FROM brain_documents d
    LEFT JOIN brain_search_documents s
      ON s.owner_id = d.owner_id AND s.scope_id = d.scope_id AND s.document_id = d.document_id
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId}
      AND d.deleted_at IS NULL${idsFilter("d.document_id", ids)}
      AND (s.document_id IS NULL OR s.incarnation <> d.incarnation OR s.revision <> d.revision
        OR s.claims_key <> ${CLAIMS_KEY}${embedded})`;
}

/** Documents whose text row needs a rebuild, whatever their embeddings. */
export async function selectPendingIds(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, ids: readonly string[] | null, limit: number,
): Promise<string[]> {
  const rows = await sql<{ document_id: string }>`SELECT d.document_id ${pendingFrom(scope, null, ids)}
    ORDER BY d.document_id LIMIT ${limit}`.execute(db);
  return rows.rows.map((row) => row.document_id);
}

/**
 * Rows at their document's live revision, of a provenance the target may send, not embedded under its marker;
 * never-tried first, then oldest failure.
 */
export async function selectEmbedPending(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, embed: BrainSearchEmbedTarget, ids: readonly string[] | null,
  limit: number,
): Promise<BrainSearchEmbedCandidate[]> {
  const rows = await sql<BuiltRow & { claims_key: string }>`SELECT s.document_id, s.incarnation, s.revision,
      s.claims_key
    FROM brain_search_documents s
    JOIN brain_documents d ON d.owner_id = s.owner_id AND d.scope_id = s.scope_id AND d.document_id = s.document_id
      AND d.deleted_at IS NULL AND d.incarnation = s.incarnation AND d.revision = s.revision
    WHERE s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId} AND ${sendable(embed)}
      AND s.embedded_provider IS DISTINCT FROM ${embed.marker}${idsFilter("s.document_id", ids)}
    ORDER BY s.embed_failed_at ASC NULLS FIRST, s.document_id LIMIT ${limit}`.execute(db);
  return rows.rows.map((row) => ({ documentId: row.document_id, incarnation: row.incarnation, revision: row.revision,
    claimsKey: row.claims_key }));
}

/** Pending documents counted up to cap + 1. */
export async function countPending(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, embed: BrainSearchEmbedTarget | null,
  ids: readonly string[] | null, cap: number,
): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM (
    SELECT 1 ${pendingFrom(scope, embed, ids)} LIMIT ${cap + 1}) p`.execute(db);
  return Number(rows.rows[0]!.n);
}

const ROW_TABLES = ["brain_search_documents", "brain_search_claims"] as const;
/** Every table holding rows of a document: the vectors go with its rows, whatever the provider. */
const DOCUMENT_TABLES = [...ROW_TABLES, "brain_search_vectors"] as const;

/** Rows `s` of the scope (and ids) whose document `d` is tombstoned; rows of erased documents went by cascade. */
const tombstoned = (scope: BrainScopeKey, ids: readonly string[] | null): SqlFragment => sql`
  s.owner_id = ${scope.ownerId} AND s.scope_id = ${scope.scopeId}${idsFilter("s.document_id", ids)}
  AND d.owner_id = s.owner_id AND d.scope_id = s.scope_id AND d.document_id = s.document_id AND d.deleted_at IS NOT NULL`;

/** Tombstoned documents that still have document or claim rows. */
export async function selectOrphans(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, ids: readonly string[] | null, limit: number,
): Promise<BrainSearchOrphan[]> {
  const from = (table: string) => sql`SELECT s.document_id, d.incarnation, d.revision
    FROM ${sql.table(table)} s, brain_documents d WHERE ${tombstoned(scope, ids)}`;
  const rows = await sql<BuiltRow>`${sql.join(ROW_TABLES.map(from), sql` UNION `)}
    ORDER BY document_id LIMIT ${limit}`.execute(db);
  return asBuilt(rows.rows);
}

/** One read transaction with a statement deadline; `snapshot` also reads one repeatable-read snapshot. */
export function withSearchRead<T>(
  db: Kysely<BrainDatabase>, fn: (trx: Transaction<BrainDatabase>) => Promise<T>, snapshot = false,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    if (snapshot) await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(trx);
    await sql`SET LOCAL statement_timeout = ${sql.lit(`${BRAIN_SEARCH_STATEMENT_TIMEOUT_MS}ms`)}`.execute(trx);
    return fn(trx);
  });
}

/** One transaction with bounded deadlines under the search scope lock. */
export function withSearchScopeWrite<T, DB extends BrainDatabase = BrainDatabase>(
  db: Kysely<DB>, scope: BrainScopeKey, fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}),
      hashtext(${`${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.search}${scope.scopeId}`}))`.execute(trx);
    return fn(trx);
  });
}

/**
 * Deletes the document rows, claim rows and array vectors of the listed documents that are still tombstoned; counts
 * the documents.
 */
export async function deleteOrphans(
  trx: Transaction<BrainDatabase>, scope: BrainScopeKey, ids: readonly string[],
): Promise<number> {
  const [documents, claims, vectors] = DOCUMENT_TABLES.map((table) => sql`DELETE FROM ${sql.table(table)} s
    USING brain_documents d WHERE ${tombstoned(scope, ids)} RETURNING s.document_id`);
  const result = await sql<{ n: number }>`WITH r AS (${documents}), c AS (${claims}), v AS (${vectors})
    SELECT count(*)::int AS n FROM (SELECT document_id FROM r UNION SELECT document_id FROM c
      UNION SELECT document_id FROM v) gone`.execute(trx);
  return Number(result.rows[0]!.n);
}

const tsv = (text: SqlFragment, weight: "A" | "B" | "D") =>
  sql`setweight(to_tsvector('simple', coalesce(${text}, '')), ${sql.lit(weight)})`;

/**
 * Rebuilds the rows and claim rows of up to BRAIN_SEARCH_REBUILD_BATCH documents; returns the (incarnation,
 * revision) indexed per live document. The row of a document no longer live stays for the sweep, which drops its
 * chunks first.
 */
export async function rebuildDocuments(
  trx: Transaction<BrainDatabase>, scope: BrainScopeKey, documentIds: readonly string[], now: Date,
): Promise<BrainSearchOrphan[]> {
  const ids = sql.join([...documentIds]);
  const refs = sql`(SELECT string_agg(r.value, ' ' ORDER BY r.kind, r.value) FROM brain_document_refs r
    WHERE r.owner_id = d.owner_id AND r.scope_id = d.scope_id AND r.document_id = d.document_id
      AND r.kind IN ('handle', 'label'))`;
  const statements = sql`(SELECT string_agg(c.statement, ' ' ORDER BY c.claim_id, c.extractor) FROM brain_claims c
    WHERE c.owner_id = d.owner_id AND c.scope_id = d.scope_id AND c.document_id = d.document_id
      AND c.incarnation = d.incarnation AND c.revision = d.revision)`;
  // Claim statements are embedded too, so a claims change re-embeds; chunks whose text is unchanged keep their vectors.
  const same = sql`brain_search_documents.incarnation = excluded.incarnation
    AND brain_search_documents.revision = excluded.revision AND brain_search_documents.claims_key = excluded.claims_key`;
  const written = await sql<BuiltRow>`
    INSERT INTO brain_search_documents
      (owner_id, scope_id, document_id, incarnation, revision, claims_key, embedded_provider, tsv, indexed_at)
    SELECT d.owner_id, d.scope_id, d.document_id, d.incarnation, d.revision, ${CLAIMS_KEY}, NULL,
      ${tsv(sql.ref("d.title"), "A")} || ${tsv(refs, "B")} || ${tsv(statements, "B")} || ${tsv(sql.ref("d.body"), "D")},
      ${now}
    FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.document_id IN (${ids})
      AND d.deleted_at IS NULL
    ON CONFLICT (owner_id, scope_id, document_id) DO UPDATE SET
      embedded_provider = CASE WHEN ${same} THEN brain_search_documents.embedded_provider END,
      embed_failed_at = CASE WHEN ${same} THEN brain_search_documents.embed_failed_at END,
      incarnation = excluded.incarnation, revision = excluded.revision, claims_key = excluded.claims_key,
      tsv = excluded.tsv, indexed_at = excluded.indexed_at
    RETURNING document_id, incarnation, revision`.execute(trx);
  const built = asBuilt(written.rows);
  await sql`DELETE FROM brain_search_claims
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND document_id IN (${ids})`.execute(trx);
  if (built.length === 0) return built;
  await sql`
    INSERT INTO brain_search_claims
      (owner_id, scope_id, document_id, claim_id, extractor, kind, incarnation, revision, tsv)
    SELECT c.owner_id, c.scope_id, c.document_id, c.claim_id, c.extractor, c.kind, c.incarnation, c.revision,
      ${tsv(sql.ref("c.label"), "A")} || ${tsv(sql.ref("c.statement"), "B")} || ${tsv(sql.ref("c.quote"), "D")}
    FROM brain_claims c
    WHERE c.owner_id = ${scope.ownerId} AND c.scope_id = ${scope.scopeId}
      AND c.document_id IN (${sql.join(built.map((row) => row.documentId))})`.execute(trx);
  return built;
}

/**
 * Marks a row embedded under `marker` (store and provider), or (marker null) records a failed attempt at `now`, only
 * while the row still holds the (incarnation, revision) and claims set the attempt was for: a slower pass for an older
 * claims set never marks a row a newer pass rebuilt.
 */
export async function markEmbedding(
  trx: Transaction<BrainDatabase>, scope: BrainScopeKey, built: BrainSearchEmbedCandidate, marker: string | null,
  now: Date,
): Promise<void> {
  const set = marker === null ? sql`embed_failed_at = ${now}`
    : sql`embedded_provider = ${marker}, embed_failed_at = NULL`;
  await sql`UPDATE brain_search_documents SET ${set}
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND document_id = ${built.documentId}
      AND incarnation = ${built.incarnation}::uuid AND revision = ${built.revision}
      AND claims_key = ${built.claimsKey}`.execute(trx);
}

/**
 * True while the document is live at (incarnation, revision) and, when a claims key is given, its search row still
 * holds that claims set: a vector write for anything else is skipped.
 */
export async function isLiveAt(
  trx: QueryExecutorProvider, scope: BrainScopeKey, built: BrainSearchOrphan & { readonly claimsKey?: string },
): Promise<boolean> {
  const claims = built.claimsKey === undefined ? sql`` : sql` AND EXISTS (SELECT 1 FROM brain_search_documents s
    WHERE s.owner_id = d.owner_id AND s.scope_id = d.scope_id AND s.document_id = d.document_id
      AND s.incarnation = d.incarnation AND s.revision = d.revision AND s.claims_key = ${built.claimsKey})`;
  const rows = await sql`SELECT 1 FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.document_id = ${built.documentId}
      AND d.deleted_at IS NULL AND d.incarnation = ${built.incarnation}::uuid
      AND d.revision = ${built.revision}${claims}`.execute(trx);
  return rows.rows.length > 0;
}

/** scope_erased: rows that survived the cascade (none are expected). */
export async function deleteScopeRows(trx: Transaction<BrainDatabase>, scope: BrainScopeKey): Promise<void> {
  for (const table of DOCUMENT_TABLES) {
    await sql`DELETE FROM ${sql.table(table)}
      WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}`.execute(trx);
  }
}

/** What the embedding pass reads per live document: title, body and the joined statements of its current claims. */
export interface BrainSearchEmbedSource {
  readonly document_id: string; readonly incarnation: string; readonly revision: number; readonly title: string;
  readonly body: string; readonly statements: string;
}

/** Only documents of a provenance the target may send are read; any other id is left out. */
export async function selectEmbedSources(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, embed: BrainSearchEmbedTarget, ids: readonly string[],
): Promise<BrainSearchEmbedSource[]> {
  const rows = await sql<BrainSearchEmbedSource>`SELECT d.document_id, d.incarnation, d.revision, d.title, d.body,
      coalesce(left((SELECT string_agg(DISTINCT c.statement, E'\\n' ORDER BY c.statement) FROM brain_claims c
        WHERE c.owner_id = d.owner_id AND c.scope_id = d.scope_id AND c.document_id = d.document_id
          AND c.incarnation = d.incarnation AND c.revision = d.revision), ${BRAIN_SEARCH_CHUNK.maxChars}::int), '')
        AS statements
    FROM brain_documents d
    WHERE d.owner_id = ${scope.ownerId} AND d.scope_id = ${scope.scopeId} AND d.deleted_at IS NULL
      AND ${sendable(embed)} AND d.document_id IN (${sql.join([...ids])})`.execute(db);
  return rows.rows;
}
