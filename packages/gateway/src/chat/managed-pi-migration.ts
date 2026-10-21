import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../bots/database.js";

/** Separate owner/Chat state; ordinary Pi runs never create recipe bots or tasks. */
export async function migrateManagedPiState(db: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`
    CREATE FUNCTION managed_pi_assert_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM chats WHERE id = NEW.chat_id AND owner_id = NEW.owner_id
        AND owner_type = 'personal' AND collaboration IS NULL) THEN
        RAISE EXCEPTION 'owner does not own private chat' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'bot_chat_owner';
      END IF;
      RETURN NEW;
    END; $$
  `.execute(db);
  await sql`
    CREATE TABLE managed_pi_sessions (
      session_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      messages JSONB NOT NULL CHECK (jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 786432),
      compacted_through_seq BIGINT CHECK (compacted_through_seq IS NULL OR compacted_through_seq >= 0),
      token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
      runtime_versions JSONB NOT NULL CHECK (jsonb_typeof(runtime_versions) = 'object' AND octet_length(runtime_versions::text) <= 8192),
      needs_recompaction BOOLEAN NOT NULL DEFAULT false,
      revision BIGINT NOT NULL CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_id, chat_id)
    )
  `.execute(db);
  await sql`CREATE TRIGGER managed_pi_sessions_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON managed_pi_sessions
    FOR EACH ROW EXECUTE FUNCTION managed_pi_assert_owner()`.execute(db);
  await sql`
    CREATE TABLE managed_pi_tool_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
      tool_call_id TEXT NOT NULL CHECK (tool_call_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
      action JSONB NOT NULL CHECK (jsonb_typeof(action) = 'object' AND octet_length(action::text) <= 6144),
      action_hash TEXT NOT NULL CHECK (action_hash ~ '^[a-f0-9]{64}$'),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('read', 'write', 'send', 'computer')),
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'dispatched', 'observed_complete', 'effect_unknown')),
      outcome_ref TEXT CHECK (outcome_ref IS NULL OR char_length(outcome_ref) <= 256),
      read_retries INTEGER NOT NULL DEFAULT 0 CHECK (read_retries BETWEEN 0 AND 2),
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_id, run_id, tool_call_id)
    )
  `.execute(db);
  await sql`CREATE FUNCTION managed_pi_assert_run() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM chat_runs WHERE id = NEW.run_id AND chat_id = NEW.chat_id AND driver_kind = 'matrix_pi') THEN
        RAISE EXCEPTION 'run does not belong to managed chat' USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'bot_chat_owner';
      END IF; RETURN NEW;
    END; $$`.execute(db);
  await sql`CREATE TRIGGER managed_pi_checkpoints_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON managed_pi_tool_checkpoints
    FOR EACH ROW EXECUTE FUNCTION managed_pi_assert_owner()`.execute(db);
  await sql`CREATE TRIGGER managed_pi_checkpoints_run BEFORE INSERT OR UPDATE OF run_id, chat_id ON managed_pi_tool_checkpoints
    FOR EACH ROW EXECUTE FUNCTION managed_pi_assert_run()`.execute(db);
  await sql`CREATE INDEX idx_managed_pi_dispatched ON managed_pi_tool_checkpoints(updated_at) WHERE phase = 'dispatched'`.execute(db);
}
