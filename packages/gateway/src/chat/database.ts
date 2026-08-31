import { sql, type ColumnType, type Generated, type Kysely } from "kysely";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type JsonValue = ColumnType<unknown, unknown, unknown>;

export interface ChatsTable {
  id: string;
  owner_type: "personal" | "organization";
  owner_id: string;
  create_request_id: string;
  project_id: string | null;
  title: string;
  lifecycle: "active" | "archived";
  attention: "none" | "approval_required" | "input_required" | "failed";
  revision: ColumnType<number, number | undefined, number>;
  message_count: ColumnType<number, number | undefined, number>;
  collaboration: JsonValue | null;
  user_state: JsonValue | null;
  shell_state: JsonValue | null;
  fork_provenance: JsonValue | null;
  last_message_preview: string | null;
  current_selection: JsonValue | null;
  bound_driver_kind: string | null;
  bound_instance_id: string | null;
  bound_at_turn_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatMembersTable {
  chat_id: string;
  principal_type: "user" | "organization";
  principal_id: string;
  role: "owner" | "editor" | "viewer";
  created_at: Timestamp;
}

export interface ChatUserStateTable {
  chat_id: string;
  principal_id: string;
  read_through_seq: ColumnType<number, number | undefined, number>;
  pinned: ColumnType<boolean, boolean | undefined, boolean>;
  muted: ColumnType<boolean, boolean | undefined, boolean>;
  attention_acknowledged_at: NullableTimestamp;
  last_opened_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface ChatMessagesTable {
  id: string;
  chat_id: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  state: "pending" | "committed" | "failed";
  turn_id: string | null;
  run_id: string | null;
  parts: JsonValue;
  byte_count: number;
  search_text: string;
  created_at: Timestamp;
}

export interface ChatAttachmentsTable {
  id: string;
  chat_id: string;
  message_id: string;
  kind: "file" | "image" | "diff" | "structured_ref";
  label: string;
  mime_type: string | null;
  size_bytes: number | null;
  owner_reference: string | null;
  created_at: Timestamp;
}

export interface ChatTurnsTable {
  id: string;
  chat_id: string;
  client_request_id: string;
  base_message_seq: number;
  input_message_id: string;
  status: "accepted" | "running" | "completed" | "failed" | "aborted";
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatRunsTable {
  id: string;
  chat_id: string;
  turn_id: string;
  client_request_id: string;
  attempt: number;
  driver_kind: string;
  instance_id: string;
  selection: JsonValue;
  interaction_mode: string;
  permission_mode: string;
  execution_root: JsonValue | null;
  execution_root_fingerprint: string | null;
  status: "accepted" | "running" | "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | "aborted";
  outcome: "completed" | "failed" | "aborted" | null;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  history_boundary_seq: number;
  capability_snapshot: JsonValue;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatQueuedTurnsTable {
  id: string;
  chat_id: string;
  client_request_id: string;
  position: number;
  status: "queued" | "claimed" | "cancelled";
  parts: JsonValue;
  driver_kind: string;
  instance_id: string;
  selection: JsonValue;
  interaction_mode: string;
  permission_mode: string;
  execution_root: JsonValue | null;
  execution_root_fingerprint: string | null;
  capability_snapshot: JsonValue;
  claimed_turn_id: string | null;
  claimed_run_id: string | null;
  cancelled_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatRunSteersTable {
  id: string;
  chat_id: string;
  run_id: string;
  turn_id: string;
  client_request_id: string;
  message_id: string;
  parts: JsonValue;
  status: "pending" | "accepted" | "failed";
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatRunEventsTable {
  id: string;
  chat_id: string;
  run_id: string;
  run_seq: Generated<number | null>;
  event: JsonValue;
  occurred_at: Timestamp;
}

export interface ChatTerminalBindingsTable {
  chat_id: string;
  session_id: string;
  session_created_at: string | null;
  run_id: string | null;
  bound_at: Timestamp;
}

export interface ChatRunAdapterStateTable {
  run_id: string;
  driver_kind: string;
  instance_id: string;
  schema_version: number;
  state: JsonValue;
  byte_count: number;
  updated_at: Timestamp;
}

export interface ChatOutboxTable {
  cursor: Generated<number>;
  owner_type: "personal" | "organization";
  owner_id: string;
  chat_id: string;
  revision: number;
  event_type: string;
  payload: JsonValue;
  created_at: Timestamp;
}

export interface ChatDeletionsTable {
  owner_type: "personal" | "organization";
  owner_id: string;
  chat_id: string;
  request_id: string;
  deleted_at: Timestamp;
}

export interface ChatLegacyImportsTable {
  owner_type: "personal" | "organization";
  owner_id: string;
  source_kind: string;
  source_id: string;
  chat_id: string;
  source_hash: string;
  import_version: number;
  verification_status: "pending" | "verified" | "failed";
  updated_at: Timestamp;
}

export interface ChatMigrationsTable {
  owner_type: "personal" | "organization";
  owner_id: string;
  migration_id: string;
  phase: string;
  source_fingerprint: string;
  imported_count: number;
  error_count: number;
  cutover_at: NullableTimestamp;
  legacy_alias_expires_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatDatabase {
  chats: ChatsTable;
  chat_members: ChatMembersTable;
  chat_user_state: ChatUserStateTable;
  chat_messages: ChatMessagesTable;
  chat_attachments: ChatAttachmentsTable;
  chat_turns: ChatTurnsTable;
  chat_runs: ChatRunsTable;
  chat_queued_turns: ChatQueuedTurnsTable;
  chat_run_steers: ChatRunSteersTable;
  chat_run_events: ChatRunEventsTable;
  chat_terminal_bindings: ChatTerminalBindingsTable;
  chat_run_adapter_state: ChatRunAdapterStateTable;
  chat_outbox: ChatOutboxTable;
  chat_deletions: ChatDeletionsTable;
  chat_legacy_imports: ChatLegacyImportsTable;
  chat_migrations: ChatMigrationsTable;
}

export async function bootstrapChatDatabase(db: Kysely<ChatDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL,
      create_request_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
      attention TEXT NOT NULL CHECK (attention IN ('none', 'approval_required', 'input_required', 'failed')),
      revision BIGINT NOT NULL DEFAULT 0,
      message_count BIGINT NOT NULL DEFAULT 0,
      collaboration JSONB,
      user_state JSONB,
      shell_state JSONB,
      fork_provenance JSONB,
      last_message_preview TEXT,
      current_selection JSONB,
      bound_driver_kind TEXT,
      bound_instance_id TEXT,
      bound_at_turn_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (owner_type, owner_id, create_request_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'organization')),
      principal_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chat_id, principal_type, principal_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_user_state (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL,
      read_through_seq BIGINT NOT NULL DEFAULT 0,
      pinned BOOLEAN NOT NULL DEFAULT false,
      muted BOOLEAN NOT NULL DEFAULT false,
      attention_acknowledged_at TIMESTAMPTZ,
      last_opened_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chat_id, principal_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      seq BIGINT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'failed')),
      turn_id TEXT,
      run_id TEXT,
      parts JSONB NOT NULL,
      byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 131072),
      search_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (chat_id, seq)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'image', 'diff', 'structured_ref')),
      label TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      owner_reference TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      base_message_seq BIGINT NOT NULL,
      input_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'aborted')),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (chat_id, client_request_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_runs (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 100),
      driver_kind TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      selection JSONB NOT NULL,
      interaction_mode TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      execution_root JSONB,
      execution_root_fingerprint TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting_for_approval', 'waiting_for_input', 'completed', 'failed', 'aborted')),
      outcome TEXT CHECK (outcome IN ('completed', 'failed', 'aborted')),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      history_boundary_seq BIGINT NOT NULL,
      capability_snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (turn_id, attempt)
    )
  `.execute(db);
  await sql`
    ALTER TABLE chat_runs
    ADD COLUMN IF NOT EXISTS execution_root_fingerprint TEXT
  `.execute(db);
  await sql`
    ALTER TABLE chat_runs
    ADD COLUMN IF NOT EXISTS client_request_id TEXT
  `.execute(db);
  await sql`
    UPDATE chat_runs AS runs
    SET client_request_id = 'req_migrated_' || md5(runs.id)
    FROM chat_turns AS turns
    WHERE runs.turn_id = turns.id AND runs.client_request_id IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE chat_runs
    ALTER COLUMN client_request_id SET NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runs_retry_request
    ON chat_runs(turn_id, client_request_id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runs_one_active
    ON chat_runs(chat_id)
    WHERE status IN ('accepted', 'running', 'waiting_for_approval', 'waiting_for_input')
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_queued_turns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
      status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'cancelled')),
      parts JSONB NOT NULL,
      driver_kind TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      selection JSONB NOT NULL,
      interaction_mode TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      execution_root JSONB,
      execution_root_fingerprint TEXT,
      capability_snapshot JSONB NOT NULL,
      claimed_turn_id TEXT REFERENCES chat_turns(id) ON DELETE SET NULL,
      claimed_run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (chat_id, client_request_id)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_queued_turns_position
    ON chat_queued_turns(chat_id, position)
    WHERE status = 'queued'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_chat_queued_turns_claim
    ON chat_queued_turns(chat_id, status, position)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_run_steers (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      parts JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'failed')),
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (chat_id, client_request_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_chat_run_steers_run
    ON chat_run_steers(run_id, status, created_at)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_run_events (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
      run_seq BIGINT,
      event JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL
    )
  `.execute(db);
  await sql`
    ALTER TABLE chat_run_events
    ADD COLUMN IF NOT EXISTS run_seq BIGINT
  `.execute(db);
  await sql`
    WITH existing_max AS (
      SELECT run_id, COALESCE(MAX(run_seq), 0) AS max_sequence
      FROM chat_run_events
      GROUP BY run_id
    ), missing AS (
      SELECT events.id,
        COALESCE(existing_max.max_sequence, 0)
          + ROW_NUMBER() OVER (
            PARTITION BY events.run_id
            ORDER BY events.occurred_at, events.id
          ) AS sequence
      FROM chat_run_events AS events
      LEFT JOIN existing_max ON existing_max.run_id = events.run_id
      WHERE events.run_seq IS NULL
    )
    UPDATE chat_run_events AS events
    SET run_seq = missing.sequence
    FROM missing
    WHERE events.id = missing.id
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_terminal_bindings (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      session_created_at TEXT,
      run_id TEXT REFERENCES chat_runs(id) ON DELETE SET NULL,
      bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chat_id, session_id)
    )
  `.execute(db);
  await sql`
    ALTER TABLE chat_terminal_bindings
    ADD COLUMN IF NOT EXISTS session_created_at TEXT
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_chat_terminal_bindings_session
    ON chat_terminal_bindings(session_id)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_run_adapter_state (
      run_id TEXT PRIMARY KEY REFERENCES chat_runs(id) ON DELETE CASCADE,
      driver_kind TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      state JSONB NOT NULL,
      byte_count INTEGER NOT NULL CHECK (byte_count >= 0 AND byte_count <= 65536),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_outbox (
      cursor BIGSERIAL PRIMARY KEY,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      revision BIGINT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_deletions (
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_type, owner_id, chat_id),
      UNIQUE (owner_type, owner_id, request_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_legacy_imports (
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      import_version INTEGER NOT NULL CHECK (import_version > 0),
      verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified', 'failed')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_type, owner_id, source_kind, source_id)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS chat_migrations (
      owner_type TEXT NOT NULL CHECK (owner_type IN ('personal', 'organization')),
      owner_id TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      imported_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      cutover_at TIMESTAMPTZ,
      legacy_alias_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_type, owner_id, migration_id)
    )
  `.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_chats_owner_updated ON chats(owner_type, owner_id, lifecycle, updated_at DESC, id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_chats_owner_project ON chats(owner_type, owner_id, project_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_page ON chat_messages(chat_id, seq)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_run_events_run_occurred ON chat_run_events(run_id, occurred_at, id)`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_run_events_run_sequence
    ON chat_run_events(run_id, run_seq)
    WHERE run_seq IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_search ON chat_messages USING GIN (to_tsvector('simple', search_text)) WHERE state = 'committed'`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_outbox_owner_cursor ON chat_outbox(owner_type, owner_id, cursor)`.execute(db);
}
