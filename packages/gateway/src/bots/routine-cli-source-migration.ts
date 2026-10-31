import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Durable revoked-generation and invocation tombstones; active limits never count history. */
export async function migrateRoutineCliSourcesV13(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE routine_cli_sources (
    source_id TEXT PRIMARY KEY CHECK (source_id ~ '^rsrc_[a-f0-9]{64}$'),
    owner_id TEXT NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    computer_id TEXT NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    source_key TEXT NOT NULL CHECK (source_key ~ '^[a-f0-9]{64}$'),
    generation TEXT NOT NULL CHECK (generation ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    context_hash TEXT NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
    source_context JSONB NOT NULL CHECK (jsonb_typeof(source_context) = 'object' AND octet_length(source_context::text) <= 8192),
    issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
    CHECK (expires_at > issued_at),
    UNIQUE (owner_id, computer_id, source_key, generation),
    UNIQUE (owner_id, computer_id, source_id)
  )`.execute(trx);
  await sql`CREATE UNIQUE INDEX routine_cli_one_live_source ON routine_cli_sources(owner_id, computer_id, source_key) WHERE revoked_at IS NULL`.execute(trx);
  await sql`CREATE INDEX routine_cli_source_expiry ON routine_cli_sources(owner_id, computer_id, expires_at) WHERE revoked_at IS NULL`.execute(trx);
  await sql`CREATE TABLE routine_cli_capabilities (
    source_id TEXT NOT NULL,
    owner_id TEXT NOT NULL, computer_id TEXT NOT NULL,
    invocation_id UUID NOT NULL,
    token_hash TEXT UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
    operation_digest TEXT NOT NULL CHECK (operation_digest ~ '^[a-f0-9]{64}$'),
    issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '2 minutes'),
    PRIMARY KEY (source_id, invocation_id),
    FOREIGN KEY (owner_id, computer_id, source_id) REFERENCES routine_cli_sources(owner_id, computer_id, source_id)
  )`.execute(trx);
  await sql`CREATE INDEX routine_cli_capability_expiry ON routine_cli_capabilities(owner_id, computer_id, expires_at) WHERE token_hash IS NOT NULL`.execute(trx);
}
