/**
 * Connector sources: the brain_connector_sources table (one validated config per connector source) and its idempotent
 * bootstrap. Rows reference brain_sources ON DELETE CASCADE, so erasing a scope removes them; core tables are only
 * read. Writes take the feature's own per-scope lock, never the core brain:<scopeId> lock.
 */
import { sql, type Kysely } from "kysely";
import {
  BRAIN_FEATURE_SCHEMA_LOCKS, BRAIN_FEATURE_SCOPE_LOCK_PREFIXES, BRAIN_SOURCE_CONFIG_LIMITS, BrainFeatureError,
} from "../../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../../types.js";
import type { BrainConnectorKind } from "./types.js";

export interface BrainConnectorSourcesTable {
  owner_id: string; scope_id: string; source_id: string; kind: BrainConnectorKind; config: unknown; updated_at: Date | string;
}
export type BrainConnectorTables = { brain_connector_sources: BrainConnectorSourcesTable };

const FOREIGN_KEY_VIOLATION = "23503";

export async function bootstrapBrainConnectorDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.connectors}))`
      .execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS brain_connector_sources (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        source_id TEXT NOT NULL CHECK (source_id ~ '^src_[a-f0-9]{32}$'),
        kind TEXT NOT NULL CHECK (kind IN ('linear', 'google_drive', 'google_calendar', 'slack_bridge')),
        config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 8192),
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, source_id),
        FOREIGN KEY (owner_id, scope_id, source_id)
          REFERENCES brain_sources (owner_id, scope_id, source_id) ON DELETE CASCADE
      )
    `.execute(trx);
  });
}

function connectorDb(db: Kysely<BrainDatabase>): Kysely<BrainConnectorTables> {
  return db.withTables<BrainConnectorTables>() as unknown as Kysely<BrainConnectorTables>;
}

/** Insert or replace; a row of another kind is source_config_invalid, a missing source is source_not_found. */
export async function saveConnectorConfig(
  db: Kysely<BrainDatabase>, kind: BrainConnectorKind, scope: BrainScopeKey, sourceId: string, config: object,
): Promise<void> {
  const json = JSON.stringify(config);
  if (Buffer.byteLength(json, "utf8") > BRAIN_SOURCE_CONFIG_LIMITS.configMaxBytes) {
    throw new BrainFeatureError("source_config_invalid");
  }
  const lockKey = `${BRAIN_FEATURE_SCOPE_LOCK_PREFIXES.connectors}${scope.scopeId}`;
  try {
    const saved = await connectorDb(db).transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${scope.ownerId}), hashtext(${lockKey}))`.execute(trx);
      return trx.insertInto("brain_connector_sources")
        .values({
          owner_id: scope.ownerId, scope_id: scope.scopeId, source_id: sourceId, kind,
          config: sql`CAST(${json} AS jsonb)`, updated_at: new Date(),
        })
        .onConflict((oc) => oc.columns(["owner_id", "scope_id", "source_id"]).doUpdateSet({
          config: sql`excluded.config`, updated_at: sql`excluded.updated_at`,
        }).where("brain_connector_sources.kind", "=", kind))
        .returning("source_id")
        .executeTakeFirst();
    });
    if (saved === undefined) throw new BrainFeatureError("source_config_invalid");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === FOREIGN_KEY_VIOLATION) throw new BrainFeatureError("source_not_found", { cause: error });
    throw error;
  }
}

/** The stored config of that kind, unparsed, or null. */
export async function loadConnectorConfig(
  db: Kysely<BrainDatabase>, kind: BrainConnectorKind, scope: BrainScopeKey, sourceId: string,
): Promise<unknown> {
  const row = await connectorDb(db).selectFrom("brain_connector_sources").select("config")
    .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
    .where("source_id", "=", sourceId).where("kind", "=", kind)
    .executeTakeFirst();
  return row === undefined ? null : row.config;
}
