import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

/** Additive owner data. Occurrence identity and owner FKs survive process/update boundaries. */
export async function migrateBotRoutinesV11(db: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`CREATE TABLE bot_routines (
    routine_id TEXT PRIMARY KEY CHECK (routine_id ~ '^rt_[a-f0-9]{24}$'),
    owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
    bot_id TEXT NOT NULL, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    proposal JSONB NOT NULL CHECK (jsonb_typeof(proposal) = 'object' AND octet_length(proposal::text) <= 24576),
    approved_source JSONB, approval_id TEXT REFERENCES bot_approvals(approval_id),
    status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
    next_fire_at TIMESTAMPTZ, revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (owner_id,bot_id,chat_id) REFERENCES bot_chat_bindings(owner_id,bot_id,chat_id),
    UNIQUE(owner_id,routine_id), UNIQUE(owner_id,approval_id)
  )`.execute(db);
  await sql`CREATE TRIGGER bot_routines_chat_owner BEFORE INSERT OR UPDATE OF chat_id,owner_id ON bot_routines
    FOR EACH ROW EXECUTE FUNCTION bot_assert_chat_owner()`.execute(db);
  await sql`CREATE INDEX idx_bot_routines_due ON bot_routines(next_fire_at) WHERE status='active'`.execute(db);
  await sql`CREATE TABLE bot_routine_fires (
    fire_id TEXT PRIMARY KEY CHECK (fire_id ~ '^fire_[a-f0-9]{24}$'),
    owner_id TEXT NOT NULL, routine_id TEXT NOT NULL, scheduled_for TIMESTAMPTZ NOT NULL,
    task_id TEXT NOT NULL REFERENCES bot_tasks(task_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('claimed','dispatched','completed','failed','cancelled','uncertain')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    retry_after TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ, failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (owner_id,routine_id) REFERENCES bot_routines(owner_id,routine_id) ON DELETE CASCADE,
    UNIQUE(owner_id,routine_id,scheduled_for), UNIQUE(owner_id,task_id)
  )`.execute(db);
  await sql`CREATE INDEX idx_bot_routine_fires_pending ON bot_routine_fires(created_at) WHERE status IN ('claimed','dispatched')`.execute(db);
}
