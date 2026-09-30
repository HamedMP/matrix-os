import { sql, type Kysely } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";

export interface SlackDatabase {
  slack_installations: { app_id: string; team_id: string; organization_id: string; installed_by: string; bot_user_id: string; encrypted_bot_token: string; generation: number; state: "active" | "revoked"; updated_at: Date | string };
  slack_oauth_states: { hash: string; actor_id: string; organization_id: string; expires_at: Date | string; consumed_at: Date | string | null };
  slack_link_challenges: { hash: string; app_id: string; team_id: string; slack_user_id: string; expires_at: Date | string; consumed_at: Date | string | null };
  slack_employee_links: { app_id: string; team_id: string; slack_user_id: string; actor_id: string; organization_id: string; created_at: Date | string };
  slack_channel_bindings: { app_id: string; team_id: string; channel_id: string; organization_id: string; scope_id: string; approved_output: boolean; configured_by: string; updated_at: Date | string };
  slack_event_receipts: { app_id: string; team_id: string; event_id: string; digest: string; state: "pending" | "completed"; lease_token: string; lease_until: Date | string; expires_at: Date | string; destination_owner_id: string | null; actor_id: string | null; slack_user_id: string | null; organization_id: string | null; channel_id: string | null; thread_ts: string | null; event_ts: string | null; scope_id: string | null; installation_generation: number | null };
  slack_reply_intents: { app_id: string; team_id: string; event_id: string; digest: string; state: "prepared" | "sent" | "unknown"; delivery_ts: string | null; expires_at: Date | string };
  slack_reaction_intents: { app_id: string; team_id: string; event_id: string; state: "prepared" | "sent" | "unknown" };
}

/** Only credentials and control metadata live here; message text and source content belong to the destination owner home. */
export async function bootstrapSlackDatabase(db: Kysely<SlackDatabase>): Promise<void> {
  await runPlatformMigration(db, async (trx) => {
    await sql`CREATE TABLE IF NOT EXISTS slack_installations (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, organization_id TEXT NOT NULL, installed_by TEXT NOT NULL,
      bot_user_id TEXT NOT NULL, encrypted_bot_token TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation > 0),
      state TEXT NOT NULL CHECK (state IN ('active','revoked')), updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (app_id,team_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_oauth_states (
      hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_link_challenges (
      hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
      FOREIGN KEY (app_id,team_id) REFERENCES slack_installations(app_id,team_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_employee_links (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (app_id,team_id,slack_user_id), UNIQUE(app_id,team_id,actor_id),
      FOREIGN KEY (app_id,team_id) REFERENCES slack_installations(app_id,team_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_channel_bindings (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, channel_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      scope_id UUID NOT NULL, approved_output BOOLEAN NOT NULL DEFAULT FALSE, configured_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(app_id,team_id,channel_id), FOREIGN KEY (app_id,team_id) REFERENCES slack_installations(app_id,team_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_event_receipts (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','completed')), lease_token UUID NOT NULL,
      lease_until TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
      destination_owner_id TEXT, actor_id TEXT, slack_user_id TEXT, organization_id TEXT, channel_id TEXT, thread_ts TEXT, event_ts TEXT, scope_id UUID, installation_generation INTEGER,
      PRIMARY KEY(app_id,team_id,event_id)
    )`.execute(trx);
    await sql`ALTER TABLE slack_event_receipts ADD COLUMN IF NOT EXISTS event_ts TEXT`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_reply_intents (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','sent','unknown')), delivery_ts TEXT, expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(app_id,team_id,event_id), FOREIGN KEY(app_id,team_id,event_id) REFERENCES slack_event_receipts(app_id,team_id,event_id) ON DELETE CASCADE
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS slack_reaction_intents (
      app_id TEXT NOT NULL, team_id TEXT NOT NULL, event_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','sent','unknown')),
      PRIMARY KEY(app_id,team_id,event_id), FOREIGN KEY(app_id,team_id,event_id) REFERENCES slack_event_receipts(app_id,team_id,event_id) ON DELETE CASCADE
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS slack_receipt_expiry ON slack_event_receipts(expires_at)`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS slack_oauth_expiry ON slack_oauth_states(expires_at)`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS slack_challenge_expiry ON slack_link_challenges(expires_at)`.execute(trx);
  });
}
