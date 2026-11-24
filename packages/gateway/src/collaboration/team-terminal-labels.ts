/**
 * Spec 2710: the owner's name for the computer a team terminal runs on, so
 * members see "Nima's MacBook" for a hosted VPS and an owned machine alike
 * without any platform field. One row per terminal scope, removed with it.
 */
import { sql, type Kysely, type Transaction } from "kysely";
import type { OwnerCollaborationDatabase } from "./database.js";

export const TEAM_TERMINAL_LABELS_MIGRATION_VERSION = 18;

export interface CollaborationTeamTerminalLabelsTable {
  scope_id: string;
  computer_label: string;
  updated_at: Date | string;
}

export async function migrateTeamTerminalLabelsV18(trx: Transaction<OwnerCollaborationDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_team_terminal_labels (
      scope_id UUID PRIMARY KEY REFERENCES collaboration_scopes(id) ON DELETE CASCADE,
      computer_label TEXT NOT NULL CHECK (char_length(computer_label) BETWEEN 1 AND 64),
      updated_at TIMESTAMPTZ NOT NULL
    )
  `.execute(trx);
  await sql`INSERT INTO collaboration_schema_migrations (version)
    VALUES (${TEAM_TERMINAL_LABELS_MIGRATION_VERSION})
    ON CONFLICT (version) DO NOTHING`.execute(trx);
}

export async function readTeamTerminalLabel(db: Kysely<OwnerCollaborationDatabase>, scopeId: string): Promise<string | null> {
  const row = await db.selectFrom("collaboration_team_terminal_labels").select("computer_label")
    .where("scope_id", "=", scopeId).executeTakeFirst();
  return row?.computer_label ?? null;
}

/** Idempotent single-row upsert; the owner check happens at the route. */
export async function writeTeamTerminalLabel(
  db: Kysely<OwnerCollaborationDatabase>,
  input: { scopeId: string; computerLabel: string; now: Date },
): Promise<void> {
  await db.insertInto("collaboration_team_terminal_labels")
    .values({ scope_id: input.scopeId, computer_label: input.computerLabel, updated_at: input.now.toISOString() })
    .onConflict((conflict) => conflict.column("scope_id").doUpdateSet({
      computer_label: input.computerLabel,
      updated_at: input.now.toISOString(),
    }))
    .execute();
}
