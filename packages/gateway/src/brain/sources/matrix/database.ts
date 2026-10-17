/**
 * Matrix sources: the one table this folder owns. brain_matrix_sources keeps the connect config of each notes, files
 * and chat source, keyed by (owner_id, scope_id, source_id) and removed with its brain_sources row. Bootstrap is
 * idempotent under the feature's schema lock; writes take the feature's per-scope lock, never the core brain lock.
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_FEATURE_SCHEMA_LOCKS, BRAIN_FEATURE_SCOPE_LOCK_PREFIXES, BRAIN_SOURCE_CONFIG_LIMITS,
  type BrainConnectableSourceKind,
} from "../../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../../types.js";

export const BRAIN_MATRIX_KINDS = ["matrix_notes", "matrix_files", "matrix_chat"] as const;
export type BrainMatrixKind = (typeof BRAIN_MATRIX_KINDS)[number] & BrainConnectableSourceKind;
type MatrixKysely = Kysely<BrainDatabase & BrainMatrixTables>;

export interface BrainMatrixSourcesTable {
  owner_id: string;
  scope_id: string;
  source_id: string;
  kind: BrainMatrixKind;
  config: unknown;
  updated_at: Date | string;
}
export type BrainMatrixTables = { brain_matrix_sources: BrainMatrixSourcesTable };

export async function bootstrapBrainMatrixDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.matrix_sources}))`
      .execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS brain_matrix_sources (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        kind TEXT NOT NULL CHECK (kind IN ('matrix_notes', 'matrix_files', 'matrix_chat')),
        config JSONB NOT NULL CHECK (
          jsonb_typeof(config) = 'object' AND octet_length(config::text) <= ${sql.lit(BRAIN_SOURCE_CONFIG_LIMITS.configMaxBytes)}
        ),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, source_id),
        FOREIGN KEY (owner_id, scope_id, source_id)
          REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE
      )
    `.execute(trx);
  });
}

function tables(kysely: Kysely<BrainDatabase>): MatrixKysely {
  return kysely.withTables<BrainMatrixTables>();
}

/** Inserts or replaces the config of one source of `kind`; a row of another kind under that id is left alone. */
export async function saveMatrixConfig(
  kysely: Kysely<BrainDatabase>, kind: BrainMatrixKind, scope: BrainScopeKey, sourceId: string, config: object,
  now: Date,
): Promise<void> {
  const json = JSON.stringify(config);
  await tables(kysely).transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
    const lockKey = `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.matrix_sources}${scope.scopeId}`;
    await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${lockKey}))`.execute(trx);
    await trx.insertInto("brain_matrix_sources").values({
      owner_id: scope.ownerId, scope_id: scope.scopeId, source_id: sourceId, kind,
      config: sql`${json}::jsonb`, updated_at: now,
    }).onConflict((oc) => oc.columns(["owner_id", "scope_id", "source_id"])
      .doUpdateSet({ config: sql`excluded.config`, updated_at: now })
      .where("brain_matrix_sources.kind", "=", kind))
      .execute();
  });
}

/** The stored config of one source of `kind`, unparsed; null when there is none. */
export async function loadMatrixConfig(
  kysely: Kysely<BrainDatabase>, kind: BrainMatrixKind, scope: BrainScopeKey, sourceId: string,
): Promise<unknown> {
  const row = await tables(kysely).selectFrom("brain_matrix_sources").select("config")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId).where("kind", "=", kind)
    .executeTakeFirst();
  return row === undefined ? null : row.config;
}
