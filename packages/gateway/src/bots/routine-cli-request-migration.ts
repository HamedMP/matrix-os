import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Immutable admission receipts survive target deletion/default switches; no cascade erases idempotency. */
export async function migrateRoutineCliRequestsV14(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE routine_cli_requests (
    owner_id TEXT NOT NULL CHECK (owner_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    computer_id TEXT NOT NULL CHECK (computer_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
    client_request_id UUID NOT NULL,
    operation_digest TEXT NOT NULL CHECK (operation_digest ~ '^[a-f0-9]{64}$'),
    operation JSONB NOT NULL CHECK (jsonb_typeof(operation) = 'object' AND octet_length(operation::text) <= 24576),
    source_context JSONB NOT NULL CHECK (jsonb_typeof(source_context) = 'object' AND octet_length(source_context::text) <= 8192),
    source_invocation JSONB NOT NULL CHECK (jsonb_typeof(source_invocation) = 'object' AND octet_length(source_invocation::text) <= 512),
    target_snapshot JSONB NOT NULL CHECK (jsonb_typeof(target_snapshot) = 'object' AND octet_length(target_snapshot::text) <= 2048),
    admission JSONB NOT NULL CHECK (jsonb_typeof(admission) = 'object' AND octet_length(admission::text) <= 2048),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0), created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (owner_id, computer_id, client_request_id)
  )`.execute(trx);
}
