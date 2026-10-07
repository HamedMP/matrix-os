import { sql, type ColumnType, type Kysely } from "kysely";
type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
export interface LocalChatImportAssetsTable {
  id: string; job_id: string; chat_id: string | null; sha256: string; mime_type: string;
  size_bytes: number; object_key: string; status: "pending" | "ready";
  cleanup_pending: boolean; created_at: Timestamp;
}
export interface LocalChatImportRecordsTable {
  job_id: string; record_key: string; logical_key: string; source_offset: number; source_block: number; chunk: number;
  role: "user" | "assistant" | "tool" | "system"; parts: ColumnType<unknown, unknown, unknown>; created_at: Timestamp;
}
export interface LocalChatPublicationDatabase {
  local_chat_import_assets: LocalChatImportAssetsTable;
  local_chat_import_records: LocalChatImportRecordsTable;
}
export async function bootstrapChatPublication<DB extends LocalChatPublicationDatabase>(db: Kysely<DB>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS local_chat_import_assets (
    id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES local_chat_import_jobs(id), chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    sha256 TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes BIGINT NOT NULL CHECK(size_bytes>=0 AND size_bytes<=67108864),
    object_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','ready')), cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(job_id,sha256,mime_type)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_local_chat_import_asset_cleanup ON local_chat_import_assets(id) WHERE cleanup_pending=TRUE`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS local_chat_import_records (
    job_id UUID NOT NULL REFERENCES local_chat_import_jobs(id) ON DELETE CASCADE, record_key TEXT NOT NULL,
    logical_key TEXT NOT NULL, source_offset BIGINT NOT NULL, source_block INTEGER NOT NULL, chunk INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), parts JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(job_id,record_key)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_local_chat_import_record_order ON local_chat_import_records(job_id,source_offset,source_block,chunk)`.execute(db);
}
