import { sql, type Kysely, type ColumnType } from "kysely";
type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null, Date | string | null>;
export interface SlackInboxTable {
  id: string; owner_id: string; envelope: ColumnType<unknown, unknown, unknown>; payload_hash: string;
  state: "pending" | "processing" | "accepted" | "completed" | "failed";
  attempts: number; lease: string | null; lease_until: NullableTimestamp;
  chat_id: string | null; scope_id: string | null; request_text: string | null; expected_revision: string | null;
  source_proofs: ColumnType<unknown, unknown, unknown>; ingestion_status: "not_requested" | "captured" | "unavailable";
  queued_turn_id: string | null; created_at: Timestamp; updated_at: Timestamp;
}
export interface SlackThreadsTable {
  thread_key: string; owner_id: string; organization_id: string; project_scope_id: string; project_id: string;
  chat_id: string; scope_id: string; updated_at: Timestamp;
}
export interface SlackOutboxTable {
  event_id: string; run_id: string; text: string; state: "pending" | "sending" | "sent" | "uncertain" | "failed";
  attempts: number; lease: string | null; lease_until: NullableTimestamp; message_ts: string | null; updated_at: Timestamp;
}
export interface SlackCompanyDatabase {
  slack_company_inbox: SlackInboxTable; slack_company_threads: SlackThreadsTable; slack_company_outbox: SlackOutboxTable;
}
/** Caller owns and drains the shared owner DB pool. No credentials live in these tables. */
export async function bootstrapSlackCompanyDatabase(db: Kysely<SlackCompanyDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(219784013)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_company_inbox (
      id uuid PRIMARY KEY, owner_id text NOT NULL, envelope jsonb NOT NULL, payload_hash text NOT NULL,
      state text NOT NULL CHECK(state IN ('pending','processing','accepted','completed','failed')),
      attempts integer NOT NULL DEFAULT 0, lease uuid, lease_until timestamptz,
      chat_id text, scope_id uuid, request_text text, expected_revision text, queued_turn_id text,
      source_proofs jsonb NOT NULL DEFAULT '[]'::jsonb, ingestion_status text NOT NULL DEFAULT 'not_requested',
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`ALTER TABLE slack_company_inbox ADD COLUMN IF NOT EXISTS source_proofs jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(trx);
    await sql`ALTER TABLE slack_company_inbox ADD COLUMN IF NOT EXISTS ingestion_status text NOT NULL DEFAULT 'not_requested'`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS slack_company_inbox_work ON slack_company_inbox(owner_id, state, updated_at)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_company_threads (
      thread_key text PRIMARY KEY, owner_id text NOT NULL, organization_id text NOT NULL,
      project_scope_id uuid NOT NULL, project_id text NOT NULL, chat_id text NOT NULL, scope_id uuid NOT NULL,
      updated_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_company_outbox (
      event_id uuid PRIMARY KEY REFERENCES slack_company_inbox(id) ON DELETE CASCADE,
      run_id text NOT NULL, text text NOT NULL, state text NOT NULL CHECK(state IN ('pending','sending','sent','uncertain','failed')),
      attempts integer NOT NULL DEFAULT 0, lease uuid, lease_until timestamptz, message_ts text, updated_at timestamptz NOT NULL
    )`.execute(trx);
  });
}
