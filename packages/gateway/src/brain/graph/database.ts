/**
 * Graph tables, created by one idempotent bootstrap under the brain_graph_schema lock after the core bootstrap.
 * Per-document rows (state, links, document entities) reference brain_documents ON DELETE CASCADE, so eraseScope
 * removes them; scope-level rows (other entities, aliases) go on scope_erased. Future changes: ADD COLUMN IF NOT
 * EXISTS.
 */
import { sql, type Kysely } from "kysely";
import { BRAIN_ENTITY_KINDS, BRAIN_FEATURE_SCHEMA_LOCKS } from "../contracts.js";
import type { BrainDatabase } from "../types.js";
import { BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT, BRAIN_GRAPH_STORED_LINK_TYPES } from "./types.js";

const quoted = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");
const OWNER_SCOPE = sql.raw(`
  owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
  scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),`);
const ENTITY_ID = (column: string) => sql.raw(`${column} TEXT NOT NULL CHECK (${column} ~ '^ent_[a-f0-9]{32}$')`);
const DOCUMENT_FK = sql.raw(`FOREIGN KEY (owner_id, scope_id, document_id)
  REFERENCES brain_documents (owner_id, scope_id, document_id) ON DELETE CASCADE`);

export async function bootstrapBrainGraphDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_FEATURE_SCHEMA_LOCKS.graph}))`
      .execute(trx);

    // What each document was derived from; a mismatch with the live row or its decision claims reads as pending.
    await sql`
      CREATE TABLE IF NOT EXISTS brain_graph_state (${OWNER_SCOPE}
        document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
        incarnation UUID NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        claims_digest TEXT NOT NULL CHECK (claims_digest ~ '^[a-f0-9]{32}$'),
        identities JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(identities) = 'array'
          AND jsonb_array_length(identities) <= ${sql.lit(BRAIN_GRAPH_IDENTITIES_PER_DOCUMENT)}),
        link_count INTEGER NOT NULL CHECK (link_count BETWEEN 0 AND 300),
        derived_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, document_id),
        ${DOCUMENT_FK}
      )
    `.execute(trx);

    // Document entities carry document_id (cascade); every other kind leaves it null (the FK is then not checked).
    await sql`
      CREATE TABLE IF NOT EXISTS brain_graph_entities (${OWNER_SCOPE}
        ${ENTITY_ID("entity_id")},
        kind TEXT NOT NULL CHECK (kind IN (${sql.raw(quoted(BRAIN_ENTITY_KINDS))})),
        key TEXT COLLATE "C" NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 512),
        display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
        document_id TEXT CHECK (document_id IS NULL OR document_id ~ '^[a-f0-9]{64}$'),
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, entity_id),
        ${DOCUMENT_FK},
        CHECK ((kind = 'document') = (document_id IS NOT NULL)),
        CHECK (first_seen_at <= last_seen_at)
      )
    `.execute(trx);

    await sql`
      CREATE TABLE IF NOT EXISTS brain_graph_links (${OWNER_SCOPE}
        link_id TEXT NOT NULL CHECK (link_id ~ '^lnk_[a-f0-9]{32}$'),
        document_id TEXT NOT NULL CHECK (document_id ~ '^[a-f0-9]{64}$'),
        type TEXT NOT NULL CHECK (type IN (${sql.raw(quoted(BRAIN_GRAPH_STORED_LINK_TYPES))})),
        mode TEXT NOT NULL CHECK (mode IN ('explicit', 'inferred')),
        ${ENTITY_ID("from_entity_id")},
        ${ENTITY_ID("to_entity_id")},
        ref_kind TEXT CHECK (ref_kind IS NULL OR ref_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
        quote TEXT CHECK (quote IS NULL OR char_length(quote) BETWEEN 1 AND 300),
        at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, link_id),
        ${DOCUMENT_FK},
        CHECK (from_entity_id <> to_entity_id)
      )
    `.execute(trx);

    // Scope level: an alias key resolves to entity_id while merged; split rows stay so derivation never re-merges.
    await sql`
      CREATE TABLE IF NOT EXISTS brain_graph_aliases (${OWNER_SCOPE}
        ${ENTITY_ID("alias_entity_id")},
        alias_key TEXT NOT NULL CHECK (char_length(alias_key) BETWEEN 1 AND 600),
        ${ENTITY_ID("entity_id")},
        reason TEXT NOT NULL CHECK (reason IN ('same_email', 'single_email_for_name', 'manual')),
        state TEXT NOT NULL CHECK (state IN ('merged', 'split')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, alias_entity_id),
        CHECK (alias_entity_id <> entity_id)
      )
    `.execute(trx);
    // The entity a carried alias was merged into (null when that is entity_id), so a split can undo a merge.
    await sql`ALTER TABLE brain_graph_aliases ADD COLUMN IF NOT EXISTS
      via_entity_id TEXT CHECK (via_entity_id IS NULL OR via_entity_id ~ '^ent_[a-f0-9]{32}$')`.execute(trx);

    for (const index of [
      "brain_graph_state_identities ON brain_graph_state USING GIN (identities jsonb_path_ops)",
      "brain_graph_entities_recent ON brain_graph_entities (owner_id, scope_id, last_seen_at DESC, entity_id DESC)",
      "brain_graph_entities_document ON brain_graph_entities (owner_id, scope_id, document_id)",
      "brain_graph_links_document ON brain_graph_links (owner_id, scope_id, document_id)",
      "brain_graph_links_from ON brain_graph_links (owner_id, scope_id, from_entity_id, at DESC, link_id DESC)",
      "brain_graph_links_to ON brain_graph_links (owner_id, scope_id, to_entity_id, at DESC, link_id DESC)",
      "brain_graph_aliases_entity ON brain_graph_aliases (owner_id, scope_id, entity_id)",
    ]) await sql.raw(`CREATE INDEX IF NOT EXISTS ${index}`).execute(trx);
  });
}
