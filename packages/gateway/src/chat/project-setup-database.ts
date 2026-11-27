import { sql, type ColumnType, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";

export interface ChatProjectSetupsTable {
  owner_id: string;
  project_id: string;
  root_fingerprint: string;
  chat_id: string | null;
  revision: number;
  draft: ColumnType<unknown, unknown, unknown>;
  last_request_id: string;
  last_request_hash: string;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

/** Additive Chat-owned draft storage. Saved project files keep configuration authority. */
export async function bootstrapProjectSetups<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS chat_project_setups (
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL,
    chat_id TEXT UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0,
    draft JSONB NOT NULL,
    last_request_id TEXT NOT NULL,
    last_request_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, project_id, root_fingerprint)
  )`.execute(db);
}
