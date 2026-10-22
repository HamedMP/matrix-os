import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
/** Additive owner-DB metadata only. Never stores actions, page contents or bearer values. */
export async function bootstrapBrowserApprovalMetadata<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async trx => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('browser_chat_authority_v1'))`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS browser_chat_leases (
      owner_id TEXT NOT NULL, epoch UUID NOT NULL, chat_id TEXT, run_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(owner_id,epoch)
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS browser_chat_leases_cleanup ON browser_chat_leases(expires_at)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS browser_chat_challenges (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE, lease_epoch UUID NOT NULL,
      action_digest TEXT NOT NULL CHECK(action_digest ~ '^[a-f0-9]{64}$'), revision INTEGER NOT NULL DEFAULT 0,
      scope_version INTEGER NOT NULL CHECK(scope_version=1), status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled','expired','consumed')),
      decision TEXT, request_id TEXT, proof_nonce TEXT, grant_id UUID, grant_revision INTEGER,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS browser_chat_challenges_pending ON browser_chat_challenges(owner_id,run_id,expires_at) WHERE status IN ('pending','approved')`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS browser_chat_challenges_cleanup ON browser_chat_challenges(expires_at)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS browser_chat_grants (
      id UUID PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
      capability TEXT NOT NULL CHECK(capability='shared_chrome'), scope_version INTEGER NOT NULL CHECK(scope_version=1),
      revision INTEGER NOT NULL CHECK(revision>0), state TEXT NOT NULL CHECK(state IN ('active','revoked')),
      origin_approval_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), revoked_at TIMESTAMPTZ
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS browser_chat_decisions (
      owner_id TEXT NOT NULL, nonce TEXT NOT NULL CHECK(nonce ~ '^[a-f0-9]{32}$'), challenge_id TEXT,
      grant_id UUID, request_id TEXT NOT NULL, decision TEXT NOT NULL, intent_digest TEXT NOT NULL,
      result JSONB, expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,nonce), UNIQUE(owner_id,request_id)
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS browser_chat_decisions_cleanup ON browser_chat_decisions(expires_at)`.execute(trx);
  });
}
