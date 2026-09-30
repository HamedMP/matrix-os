/** Owner import persistence, extracted from the large canonical database bootstrap. */
import { sql, type ColumnType, type Kysely } from "kysely";
import { bootstrapChatPublication, type LocalChatPublicationDatabase } from "./local-import/publication-database.js";
type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
export interface ChatImportJobsTable {
  owner_type: "personal";
  owner_id: string;
  source_id: string;
  source_hash: string;
  title: string;
  status: "uploading" | "verified";
  chat_id: string | null;
  next_seq: number;
  total_bytes: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatImportMessagesTable {
  owner_id: string;
  source_id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  created_at: Timestamp;
}


export type LocalImportStatus = "creating" | "uploading" | "sealing" | "uploaded" | "verifying" | "published" | "failed" | "cancelled" | "expired";
export interface LocalChatImportJobsTable {
  id: string; owner_id: string; harness: "codex" | "claude"; source_id: string; source_agent_id: string;
  source_hash: string; raw_size: number; title: string; status: LocalImportStatus;
  object_key: string; upload_id: string | null; chat_id: string | null;
  lease_token: string | null; lease_expires_at: NullableTimestamp;
  cleanup_pending: boolean; error_code: string | null; expires_at: Timestamp;
  created_at: Timestamp; updated_at: Timestamp;
}
export interface LocalChatImportPartsTable { job_id: string; part_number: number; etag: string; size_bytes: number }
export interface ChatImportDatabase extends LocalChatPublicationDatabase {
  chat_import_jobs: ChatImportJobsTable;
  chat_import_messages: ChatImportMessagesTable;
  local_chat_import_jobs: LocalChatImportJobsTable;
  local_chat_import_parts: LocalChatImportPartsTable;
}
export async function bootstrapChatImports<Database extends ChatImportDatabase>(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_import_jobs (
      owner_type TEXT NOT NULL CHECK (owner_type = 'personal'),
      owner_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('uploading', 'verified')),
      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      next_seq BIGINT NOT NULL DEFAULT 1,
      total_bytes BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, source_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_import_messages (
      owner_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      seq BIGINT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, source_id, seq),
      FOREIGN KEY (owner_id, source_id) REFERENCES chat_import_jobs(owner_id, source_id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS local_chat_import_jobs (
    id UUID PRIMARY KEY, owner_id TEXT NOT NULL, harness TEXT NOT NULL CHECK (harness IN ('codex','claude')),
    source_id UUID NOT NULL, source_agent_id TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL,
    raw_size BIGINT NOT NULL CHECK (raw_size > 0 AND raw_size <= 21474836480), title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('creating','uploading','sealing','uploaded','verifying','published','failed','cancelled','expired')),
    object_key TEXT NOT NULL UNIQUE, upload_id TEXT, chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    lease_token UUID, lease_expires_at TIMESTAMPTZ, cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE, error_code TEXT,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`ALTER TABLE local_chat_import_jobs ADD COLUMN IF NOT EXISTS lease_token UUID`.execute(db);
  await sql`ALTER TABLE local_chat_import_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_local_chat_import_source_live
    ON local_chat_import_jobs(owner_id,harness,source_id,source_agent_id,source_hash)
    WHERE status NOT IN ('failed','cancelled','expired')`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_local_chat_import_expiry ON local_chat_import_jobs(expires_at)
    WHERE status NOT IN ('published','failed','cancelled','expired')`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS local_chat_import_parts (
    job_id UUID NOT NULL REFERENCES local_chat_import_jobs(id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number > 0 AND part_number <= 320), etag TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 67108864),
    PRIMARY KEY(job_id,part_number)
  )`.execute(db);
  await bootstrapChatPublication(db);
}
