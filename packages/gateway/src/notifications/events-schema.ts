import { sql, type ColumnType, type Transaction } from "kysely";
import type { NotificationDatabase } from "./schema.js";

type Timestamp = ColumnType<Date, Date, Date>;
export interface NotificationEventsTable {
  id: string; owner_id: string; dedupe_key: string;
  kind: "approval" | "question";
  source: "canonical_chat" | "bot";
  source_ref: string; chat_id: string; run_id: string | null;
  title: string; preview: string | null; urgency: "high";
  state: "open" | "sending" | "pushed" | "resolved" | "expired" | "suppressed" | "failed";
  phone_send_after: Timestamp; evaluated_at: Timestamp | null; claimed_at: Timestamp | null;
  claim_token: string | null; push_attempts: number;
  expires_at: Timestamp; created_at: Timestamp; resolved_at: Timestamp | null;
}
export interface NotificationAttemptsTable {
  id: string; event_id: string; channel: "expo_push"; device_id: string | null;
  outcome: "sent" | "failed"; created_at: Timestamp;
}

export async function createAttentionTables(trx: Transaction<NotificationDatabase>): Promise<void> {
  await sql`CREATE TABLE notification_events (
    id uuid PRIMARY KEY, owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
    dedupe_key text NOT NULL CHECK (char_length(dedupe_key) <= 512),
    kind text NOT NULL CHECK (kind IN ('approval','question')),
    source text NOT NULL CHECK (source IN ('canonical_chat','bot')),
    source_ref text NOT NULL CHECK (char_length(source_ref) <= 160),
    chat_id text NOT NULL, run_id text,
    title text NOT NULL CHECK (char_length(title) <= 80), preview text CHECK (char_length(preview) <= 180),
    urgency text NOT NULL CHECK (urgency = 'high'),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','sending','pushed','resolved','expired','suppressed','failed')),
    phone_send_after timestamptz NOT NULL, evaluated_at timestamptz, claimed_at timestamptz, claim_token uuid,
    push_attempts smallint NOT NULL DEFAULT 0 CHECK (push_attempts BETWEEN 0 AND 3),
    expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL, resolved_at timestamptz,
    UNIQUE(owner_id,dedupe_key)
  )`.execute(trx);
  await sql`CREATE INDEX notification_events_due ON notification_events(owner_id,phone_send_after) WHERE state='open'`.execute(trx);
  await sql`CREATE INDEX notification_events_claimed ON notification_events(claimed_at) WHERE state='sending'`.execute(trx);
  await sql`CREATE TABLE notification_attempts (
    id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel='expo_push'), device_id text,
    outcome text NOT NULL CHECK (outcome IN ('sent','failed')), created_at timestamptz NOT NULL
  )`.execute(trx);
}
