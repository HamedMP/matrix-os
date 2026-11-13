import { sql, type Kysely, type Transaction } from "kysely";
import type { TerminalRef } from "@matrix-os/contracts";
import type { OwnerCollaborationDatabase } from "./database.js";

export interface CollaborationTerminalBindingsTable {
  scope_id: string;
  owner_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  tab_created_at: Date | string;
  tab_incarnation: string;
  incarnation: string;
  execution_generation: number;
  /** S07 owner opt-in: Contributors may control this host shell only when true. */
  contributor_control: boolean;
  created_at: Date | string;
}

/** Match the current incarnation. A retained row for a replaced tab has no control of its successor. */
export async function hasTerminalCollaborationBinding(db: Kysely<OwnerCollaborationDatabase>, ref: TerminalRef, incarnation: string): Promise<boolean> {
  return !!await db.selectFrom("collaboration_terminal_bindings").select("scope_id")
    .where("terminal_id", "=", `${ref.workspaceId}:${ref.tabId}`).where("tab_incarnation", "=", incarnation).executeTakeFirst();
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
      tab_incarnation TEXT NOT NULL CHECK (tab_incarnation ~ '^ti_[a-f0-9]{32}$'),
      incarnation TEXT NOT NULL CHECK (incarnation ~ '^terminal-[a-f0-9]{32}$'),
      execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
      contributor_control BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL,
      CHECK (terminal_id = workspace_id || ':' || tab_id)
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version) VALUES (15)
    ON CONFLICT (version) DO NOTHING`.execute(trx);
}
