import { sql, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

export interface CollaborationTerminalBindingsTable {
  scope_id: string;
  owner_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  tab_created_at: Date | string;
  incarnation: string;
  execution_generation: number;
  created_at: Date | string;
}

export async function migrateTerminalBindingsV15(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_terminal_bindings (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      terminal_id TEXT NOT NULL UNIQUE CHECK (terminal_id ~ '^tws_[a-f0-9]{32}:tt_[a-f0-9]{32}$'),
      workspace_id TEXT NOT NULL CHECK (workspace_id ~ '^tws_[a-f0-9]{32}$'),
      tab_id TEXT NOT NULL CHECK (tab_id ~ '^tt_[a-f0-9]{32}$'),
      tab_created_at TIMESTAMPTZ NOT NULL,
      incarnation TEXT NOT NULL CHECK (incarnation ~ '^terminal-[a-f0-9]{32}$'),
      execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
      created_at TIMESTAMPTZ NOT NULL,
      CHECK (terminal_id = workspace_id || ':' || tab_id)
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version) VALUES (15)
    ON CONFLICT (version) DO NOTHING`.execute(trx);
}
