import { sql, type Kysely, type Generated } from 'kysely';

export interface AtsInboxTable {
  id: string;
  message_id: string;
  thread_id: string;
  sender_name: string;
  sender_email: string;
  applicant_email: Generated<string>;
  subject: string;
  body: string;
  received_at: string;
  source_url: string;
  application_id: string | null;
  category: string;
}

export interface AtsNotificationOutboxTable {
  id: string;
  entity_key: string;
  payload: string;
  attempts: number;
  available_at: string;
  lease_until: string | null;
  lease_token: string | null;
  sent_at: string | null;
  slack_ts: string | null;
  created_at: string;
}

export interface AtsLegacyImportsTable { legacy_key: string; application_id: string }

export interface AtsMailAttachmentsTable {
  id: string; message_id: string; filename: string; content_type: string; bytes: Uint8Array;
}

export async function migrateAtsIntake<T>(db: Kysely<T>): Promise<void> {
  await sql`ALTER TABLE ats_applications ALTER COLUMN consent_at DROP NOT NULL`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ats_inbox_messages (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    sender_name TEXT NOT NULL, sender_email TEXT NOT NULL, subject TEXT NOT NULL,
    body TEXT NOT NULL, received_at TEXT NOT NULL, source_url TEXT NOT NULL,
    application_id TEXT REFERENCES ats_applications(id) ON DELETE SET NULL,
    category TEXT NOT NULL DEFAULT 'needs_review'
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_inbox_application ON ats_inbox_messages(application_id, received_at DESC)`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ats_mail_attachments (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ats_inbox_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, content_type TEXT NOT NULL, bytes BYTEA NOT NULL
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ats_legacy_imports (legacy_key TEXT PRIMARY KEY, application_id TEXT NOT NULL REFERENCES ats_applications(id))`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ats_notification_outbox (
    id TEXT PRIMARY KEY, entity_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
    lease_until TEXT, lease_token TEXT, sent_at TEXT, slack_ts TEXT, created_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ats_notification_pending ON ats_notification_outbox(available_at) WHERE sent_at IS NULL`.execute(db);
}
