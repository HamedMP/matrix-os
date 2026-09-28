/**
 * Versioned migrations for owner bot state (spec 536, data-model.md). Each
 * version runs once, in order, inside its own transaction; the runner in
 * database.ts records it in `bot_schema_migrations`. Chat tables must exist
 * first: bindings, sessions, tasks, and interactions reference `chats`.
 *
 * Every owner row carries `owner_id`, and every unique index includes it.
 * CHECK constraints back the byte and format bounds that Zod enforces at the
 * route and broker boundaries.
 */
import { sql, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "./database.js";

const OWNER = "owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128)";
const BOT_ID = (column: string) => `${column} TEXT NOT NULL CHECK (${column} ~ '^bot_[a-z0-9]{8,64}$')`;
const CHAT_ID_PATTERN = "'^chat_[A-Za-z0-9_-]{1,128}$'";
const RUN_ID_PATTERN = "'^run_[A-Za-z0-9_-]{1,128}$'";
const AUDIENCE_CHECK = (column: string) => `(${column} = 'direct' OR ${column} ~ '^group:chat_[A-Za-z0-9_-]{1,128}$')`;
const SERVICE_CHECK = (column: string) => `${column} ~ '^[a-z][a-z0-9_]{1,63}$'`;
const CONNECTION_CHECK = (column: string) => `${column} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'`;
/** jsonb text adds spacing, so DDL bounds sit above the compact JSON limits the repositories enforce. */
const jsonObject = (column: string, maxBytes: number) =>
  `jsonb_typeof(${column}) = 'object' AND octet_length(${column}::text) <= ${maxBytes}`;

async function migrateBotStateV1(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  // A chat foreign key proves only that the chat exists; this also proves the bot
  // row's owner owns it, for every caller. Group chats (M3) relax it in a later version.
  await sql`
    CREATE FUNCTION bot_assert_chat_owner() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM chats WHERE id = NEW.chat_id AND owner_id = NEW.owner_id) THEN
        RAISE EXCEPTION 'bot row owner does not own the chat'
          USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'bot_chat_owner';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(trx);
  await sql.raw(`
    CREATE TABLE bot_operations (
      ${OWNER},
      client_request_id TEXT NOT NULL CHECK (client_request_id ~ '^req_[A-Za-z0-9_-]{1,128}$'),
      ${BOT_ID("bot_id")},
      chat_id TEXT NOT NULL CHECK (chat_id ~ ${CHAT_ID_PATTERN}),
      workspace_rel_path TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'file_created', 'active', 'failed_recoverable')),
      failure_code TEXT CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, client_request_id),
      UNIQUE (owner_id, bot_id),
      UNIQUE (owner_id, chat_id),
      CHECK (workspace_rel_path = 'bots/' || bot_id),
      CHECK ((status = 'failed_recoverable') = (failure_code IS NOT NULL))
    )
  `).execute(trx);
  await sql`
    CREATE INDEX idx_bot_operations_unfinished ON bot_operations(owner_id, updated_at)
    WHERE status <> 'active'
  `.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_chat_bindings (
      ${OWNER},
      ${BOT_ID("bot_id")},
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
      created_at TIMESTAMPTZ NOT NULL,
      removed_at TIMESTAMPTZ,
      PRIMARY KEY (owner_id, bot_id, chat_id)
    )
  `).execute(trx);
  await sql`
    CREATE UNIQUE INDEX idx_bot_chat_bindings_one_direct ON bot_chat_bindings(owner_id, bot_id)
    WHERE kind = 'direct' AND removed_at IS NULL
  `.execute(trx);
  await sql`
    CREATE TRIGGER bot_chat_bindings_chat_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON bot_chat_bindings
    FOR EACH ROW EXECUTE FUNCTION bot_assert_chat_owner()
  `.execute(trx);
  await sql`
    CREATE INDEX idx_bot_chat_bindings_chat ON bot_chat_bindings(owner_id, chat_id) WHERE removed_at IS NULL
  `.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_agent_sessions (
      session_id TEXT PRIMARY KEY CHECK (session_id ~ '^bses_[a-z0-9]{8,64}$'),
      ${OWNER},
      ${BOT_ID("bot_id")},
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      messages JSONB NOT NULL CHECK (jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 786432),
      compacted_through_seq BIGINT CHECK (compacted_through_seq IS NULL OR compacted_through_seq >= 0),
      token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
      runtime_versions JSONB NOT NULL CHECK (${jsonObject("runtime_versions", 8192)}),
      needs_recompaction BOOLEAN NOT NULL DEFAULT false,
      revision BIGINT NOT NULL CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_id, bot_id, chat_id)
    )
  `).execute(trx);

  await sql`
    CREATE TRIGGER bot_agent_sessions_chat_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON bot_agent_sessions
    FOR EACH ROW EXECUTE FUNCTION bot_assert_chat_owner()
  `.execute(trx);
  await sql.raw(`
    CREATE TABLE bot_tasks (
      task_id TEXT PRIMARY KEY CHECK (task_id ~ '^task_[a-z0-9]{8,64}$'),
      ${OWNER},
      ${BOT_ID("bot_id")},
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES bot_tasks(task_id) ON DELETE CASCADE,
      coordinator_bot_id TEXT CHECK (coordinator_bot_id IS NULL OR coordinator_bot_id ~ '^bot_[a-z0-9]{8,64}$'),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'waiting_person', 'waiting_capacity', 'blocked', 'completed', 'failed', 'cancelled'
      )),
      run_id TEXT CHECK (run_id IS NULL OR run_id ~ ${RUN_ID_PATTERN}),
      budget JSONB NOT NULL CHECK (${jsonObject("budget", 1024)}),
      active_ms BIGINT NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      running_since TIMESTAMPTZ,
      blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN (
        'root_unavailable', 'grant_revoked', 'budget_exhausted', 'tool_unavailable', 'model_unavailable',
        'funds_unavailable', 'capacity_unavailable', 'deadline_reached', 'policy_denied'
      )),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      CHECK ((status = 'blocked') = (blocked_reason IS NOT NULL)),
      CHECK ((status = 'running') = (running_since IS NOT NULL))
    )
  `).execute(trx);
  await sql`
    CREATE TRIGGER bot_tasks_chat_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON bot_tasks
    FOR EACH ROW EXECUTE FUNCTION bot_assert_chat_owner()
  `.execute(trx);
  await sql`
    CREATE INDEX idx_bot_tasks_open ON bot_tasks(owner_id, bot_id, chat_id)
    WHERE status NOT IN ('completed', 'failed', 'cancelled')
  `.execute(trx);
  await sql`CREATE INDEX idx_bot_tasks_parent ON bot_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_tool_checkpoints (
      checkpoint_id TEXT PRIMARY KEY CHECK (checkpoint_id ~ '^ckpt_[a-z0-9]{8,64}$'),
      ${OWNER},
      task_id TEXT NOT NULL REFERENCES bot_tasks(task_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL CHECK (run_id ~ ${RUN_ID_PATTERN}),
      tool_call_id TEXT NOT NULL CHECK (tool_call_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
      action JSONB NOT NULL CHECK (${jsonObject("action", 6144)}),
      action_hash TEXT NOT NULL CHECK (action_hash ~ '^[a-f0-9]{64}$'),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('read', 'write', 'send', 'computer')),
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'dispatched', 'observed_complete', 'effect_unknown')),
      outcome_ref TEXT CHECK (outcome_ref IS NULL OR outcome_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$'),
      read_retries INTEGER NOT NULL DEFAULT 0 CHECK (read_retries BETWEEN 0 AND 2),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_id, run_id, tool_call_id)
    )
  `).execute(trx);
  await sql`
    CREATE INDEX idx_bot_tool_checkpoints_dispatched ON bot_tool_checkpoints(updated_at) WHERE phase = 'dispatched'
  `.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_interactions (
      interaction_id TEXT PRIMARY KEY CHECK (interaction_id ~ '^in_[A-Za-z0-9_-]{8,64}$'),
      ${OWNER},
      ${BOT_ID("bot_id")},
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES bot_tasks(task_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'account_choice', 'connect_request', 'approval')),
      payload JSONB NOT NULL CHECK (${jsonObject("payload", 24576)}),
      responder_actor_id TEXT NOT NULL CHECK (char_length(responder_actor_id) BETWEEN 1 AND 128),
      blocking BOOLEAN NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'expired', 'cancelled')),
      resolution JSONB CHECK (resolution IS NULL OR (${jsonObject("resolution", 24576)})),
      expires_at TIMESTAMPTZ NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      CHECK ((status = 'resolved') = (resolution IS NOT NULL)),
      CHECK ((status = 'pending') = (resolved_at IS NULL)),
      CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
      CHECK (kind <> 'connect_request' OR expires_at <= created_at + interval '15 minutes')
    )
  `).execute(trx);
  await sql`
    CREATE TRIGGER bot_interactions_chat_owner BEFORE INSERT OR UPDATE OF chat_id, owner_id ON bot_interactions
    FOR EACH ROW EXECUTE FUNCTION bot_assert_chat_owner()
  `.execute(trx);
  await sql`
    CREATE UNIQUE INDEX idx_bot_interactions_one_blocking ON bot_interactions(owner_id, task_id)
    WHERE blocking AND status = 'pending'
  `.execute(trx);
  await sql`
    CREATE INDEX idx_bot_interactions_pending ON bot_interactions(owner_id, expires_at) WHERE status = 'pending'
  `.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_connect_requests (
      request_id TEXT PRIMARY KEY CHECK (request_id ~ '^cr_[A-Za-z0-9_-]{8,64}$'),
      ${OWNER},
      interaction_id TEXT NOT NULL REFERENCES bot_interactions(interaction_id) ON DELETE CASCADE,
      service TEXT NOT NULL CHECK (${SERVICE_CHECK("service")}),
      requested_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      baseline_connection_ids JSONB NOT NULL
        CHECK (jsonb_typeof(baseline_connection_ids) = 'array' AND jsonb_array_length(baseline_connection_ids) <= 64),
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'ambiguous', 'cancelled', 'expired')),
      completed_connection_id TEXT CHECK (completed_connection_id IS NULL OR ${CONNECTION_CHECK("completed_connection_id")}),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (owner_id, interaction_id),
      CHECK ((status = 'completed') = (completed_connection_id IS NOT NULL)),
      CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '15 minutes')
    )
  `).execute(trx);

  await sql.raw(`
    CREATE TABLE bot_grants (
      grant_id TEXT PRIMARY KEY CHECK (grant_id ~ '^gr_[A-Za-z0-9_-]{8,64}$'),
      ${OWNER},
      ${BOT_ID("bot_id")},
      service TEXT NOT NULL CHECK (${SERVICE_CHECK("service")}),
      connection_id TEXT NOT NULL CHECK (${CONNECTION_CHECK("connection_id")}),
      account_label TEXT NOT NULL CHECK (char_length(account_label) BETWEEN 1 AND 120),
      effects TEXT[] NOT NULL CHECK (
        cardinality(effects) BETWEEN 1 AND 3 AND effects <@ ARRAY['read', 'write', 'send']::text[]
      ),
      audience TEXT NOT NULL CHECK ${AUDIENCE_CHECK("audience")},
      granted_by_actor_id TEXT NOT NULL CHECK (char_length(granted_by_actor_id) BETWEEN 1 AND 128),
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `).execute(trx);
  await sql`
    CREATE UNIQUE INDEX idx_bot_grants_live ON bot_grants(owner_id, bot_id, service, connection_id, audience)
    WHERE revoked_at IS NULL
  `.execute(trx);

  await sql.raw(`
    CREATE TABLE bot_approvals (
      approval_id TEXT PRIMARY KEY REFERENCES bot_interactions(interaction_id) ON DELETE CASCADE,
      ${OWNER},
      ${BOT_ID("bot_id")},
      run_id TEXT NOT NULL CHECK (run_id ~ ${RUN_ID_PATTERN}),
      tool TEXT NOT NULL CHECK (tool ~ '^[a-z][a-z_.]{1,63}$'),
      args_hash TEXT NOT NULL CHECK (args_hash ~ '^[a-f0-9]{64}$'),
      account TEXT NOT NULL CHECK (char_length(account) BETWEEN 1 AND 256),
      audience TEXT NOT NULL CHECK ${AUDIENCE_CHECK("audience")},
      policy_revision BIGINT NOT NULL CHECK (policy_revision >= 0),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'invalidated')),
      claimed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `).execute(trx);

  await sql.raw(`
    CREATE TABLE bot_memory_items (
      item_id TEXT PRIMARY KEY CHECK (item_id ~ '^mem_[A-Za-z0-9_-]{8,64}$'),
      ${OWNER},
      ${BOT_ID("bot_id")},
      kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'episode')),
      scope TEXT NOT NULL CHECK (scope = 'bot' OR scope ~ '^(chat|group):chat_[A-Za-z0-9_-]{1,128}$'),
      content TEXT NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 4096),
      content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
      source JSONB NOT NULL CHECK (${jsonObject("source", 6144)}),
      confirmed BOOLEAN NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      forgotten_at TIMESTAMPTZ
    )
  `).execute(trx);
  await sql`
    CREATE INDEX idx_bot_memory_live ON bot_memory_items(owner_id, bot_id) WHERE forgotten_at IS NULL
  `.execute(trx);
  await sql`CREATE INDEX idx_bot_memory_search ON bot_memory_items USING GIN (content_tsv)`.execute(trx);
}

/**
 * v2: approvals bind the task instead of the run. A blocking approval ends
 * the run that asked; the person's decision arrives in a continuation run of
 * the same task, which must be able to claim it.
 */
async function migrateApprovalsByTaskV2(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`ALTER TABLE bot_approvals ADD COLUMN task_id TEXT REFERENCES bot_tasks(task_id) ON DELETE CASCADE`.execute(trx);
  await sql`
    UPDATE bot_approvals AS approval SET task_id = interaction.task_id
    FROM bot_interactions AS interaction WHERE interaction.interaction_id = approval.approval_id
  `.execute(trx);
  await sql`ALTER TABLE bot_approvals ALTER COLUMN task_id SET NOT NULL`.execute(trx);
  await sql`
    CREATE INDEX idx_bot_approvals_open ON bot_approvals(owner_id, task_id, tool, args_hash)
    WHERE status IN ('pending', 'approved') AND claimed_at IS NULL
  `.execute(trx);
}

/** Failed inventory reads defer one owner briefly so later owners make progress. */
async function migrateConnectRetryScheduleV3(trx: Transaction<OwnerBotDatabase>): Promise<void> {
  await sql`ALTER TABLE bot_connect_requests ADD COLUMN retry_after TIMESTAMPTZ`.execute(trx);
  await sql`CREATE INDEX idx_bot_connect_requests_due ON bot_connect_requests(retry_after, requested_at) WHERE status = 'pending'`.execute(trx);
}

export interface BotMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (trx: Transaction<OwnerBotDatabase>) => Promise<void>;
}

/** Applied in this order; never edit a released version, add a new one. */
export const BOT_MIGRATIONS: readonly BotMigration[] = [
  { version: 1, name: "bot_state_m1", up: migrateBotStateV1 },
  { version: 2, name: "bot_approvals_by_task", up: migrateApprovalsByTaskV2 },
  { version: 3, name: "bot_connect_retry_schedule", up: migrateConnectRetryScheduleV3 },
];
