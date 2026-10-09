import { sql, type Kysely } from 'kysely';
export interface AtsSlackThreadTable { thread_key:string; root_ts:string|null; lease_token:string|null; lease_until:string|null }
export interface AtsSlackPartTable { part_key:string; result_id:string; completed_at:string }
export interface AtsSlackUploadTable { upload_key:string; file_id:string; upload_url:string|null; uploaded_at:string|null; completed_at:string|null }
export async function migrateAtsSlack<T>(db:Kysely<T>){
 await sql`ALTER TABLE ats_inbox_messages ADD COLUMN IF NOT EXISTS applicant_email TEXT NOT NULL DEFAULT ''`.execute(db);
 await sql`UPDATE ats_inbox_messages SET applicant_email=sender_email WHERE applicant_email='' AND sender_email<>''`.execute(db);
 await sql`CREATE TABLE IF NOT EXISTS ats_slack_threads (thread_key TEXT PRIMARY KEY,root_ts TEXT,lease_token TEXT,lease_until TEXT)`.execute(db);
 await sql`CREATE TABLE IF NOT EXISTS ats_slack_parts (part_key TEXT PRIMARY KEY,result_id TEXT NOT NULL,completed_at TEXT NOT NULL)`.execute(db);
 await sql`CREATE TABLE IF NOT EXISTS ats_slack_uploads (upload_key TEXT PRIMARY KEY,file_id TEXT NOT NULL,upload_url TEXT,uploaded_at TEXT,completed_at TEXT)`.execute(db);
}
