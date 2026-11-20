import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;

export interface BoardSchemaMigrationsTable { version: number; applied_at: Timestamp }

export interface BoardBoardsTable {
  id: string;
  owner_id: string;
  name: string;
  scope: "personal" | "organization";
  /** Last event cursor handed out; writes increment it under the board row lock. */
  last_cursor: ColumnType<string, string | number, string | number>;
  created_at: Timestamp;
}

export interface BoardChannelsTable {
  owner_id: string;
  board_id: string;
  path: string;
  created_by: string;
  created_at: Timestamp;
}

export interface StoredBoardActor { id: string; kind: string; name: string; profile?: string }

export interface BoardMessagesTable {
  id: string;
  /** Insertion order; writes serialize per board, so it is also commit order. */
  seq: ColumnType<string, never, never>;
  owner_id: string;
  board_id: string;
  channel: string;
  /** Thread root, or null for a root. */
  root_id: string | null;
  reply_to: string | null;
  author: string;
  author_actor: Json<StoredBoardActor>;
  text: string;
  mentions: Json<string[]>;
  revision: number;
  idempotency_key: string | null;
  reply_count: number;
  last_activity_at: Timestamp;
  last_actor: string;
  created_at: Timestamp;
  edited_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

export interface BoardLabelsTable { owner_id: string; message_id: string; key: string; value: string }
export interface BoardReactionsTable { owner_id: string; message_id: string; actor: string; emoji: string; created_at: Timestamp }

export interface BoardEventsTable {
  owner_id: string;
  board_id: string;
  cursor: ColumnType<string, string | number, never>;
  type: string;
  actor: Json<StoredBoardActor>;
  channel: string | null;
  message_id: string | null;
  thread_id: string | null;
  payload: Json<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface BoardReadsTable { owner_id: string; board_id: string; actor: string; root_id: string; read_at: Timestamp }

export interface BoardTasksTable {
  root_id: string;
  owner_id: string;
  board_id: string;
  /** The root's channel; paths never change, so events can be filtered without a join. */
  channel: string;
  state: "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed" | "canceled";
  /** Actor ID of the creator. */
  owner_actor: string;
  assigned_profile: string | null;
  claim_holder: Json<StoredBoardActor | null>;
  claim_epoch: number;
  claim_token_hash: string | null;
  lease_until: NullableTimestamp;
  result: string | null;
  failure_reason: string | null;
  cancel_reason: string | null;
  blocked_reason: string | null;
  blocked_kind: string | null;
  updated_at: Timestamp;
}

export interface BoardTaskNeedsTable { owner_id: string; task_id: string; needs_task_id: string }

export interface BoardWatchersTable {
  id: string;
  owner_id: string;
  board_id: string;
  name: string;
  tail: Json<{ channel: string; label?: string; by?: string }>;
  action: Json<Record<string, unknown>>;
  enabled: boolean;
  max_runs_per_hour: number;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BoardWatcherRunsTable {
  owner_id: string;
  watcher_id: string;
  event_cursor: ColumnType<string, string | number, never>;
  message_id: string;
  /** null while pending or retrying. */
  outcome: "ok" | "failed" | null;
  attempts: number;
  next_attempt_at: Timestamp;
  last_error: string | null;
  created_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface BoardSchedulesTable {
  id: string;
  owner_id: string;
  board_id: string;
  author: string;
  author_actor: Json<StoredBoardActor>;
  channel: string;
  thread_id: string | null;
  text: string;
  next_run_at: Timestamp;
  every: string | null;
  remaining: number | null;
  until_at: NullableTimestamp;
  run_count: number;
  /** The author's watcher provenance, so scheduled posts keep their loop guard. */
  origin: Json<{ watcher: string; depth: number } | null>;
  created_at: Timestamp;
}

/** How far watchers have matched each board's event log; survives restarts and queue overflow. */
export interface BoardWatcherProgressTable { owner_id: string; board_id: string; cursor: ColumnType<string, string | number, string | number>; updated_at: Timestamp }

export interface BoardGrantsTable {
  id: string;
  owner_id: string;
  board_id: string;
  principal: string;
  pattern: string;
  permissions: Json<string[]>;
  created_by: string;
  created_at: Timestamp;
}

export interface MessageBoardDatabase {
  board_schema_migrations: BoardSchemaMigrationsTable;
  board_boards: BoardBoardsTable;
  board_channels: BoardChannelsTable;
  board_messages: BoardMessagesTable;
  board_labels: BoardLabelsTable;
  board_reactions: BoardReactionsTable;
  board_events: BoardEventsTable;
  board_reads: BoardReadsTable;
  board_tasks: BoardTasksTable;
  board_task_needs: BoardTaskNeedsTable;
  board_watchers: BoardWatchersTable;
  board_watcher_runs: BoardWatcherRunsTable;
  board_schedules: BoardSchedulesTable;
  board_grants: BoardGrantsTable;
  board_watcher_progress: BoardWatcherProgressTable;
}

/** Distinct from every other gateway advisory lock key. */
const MESSAGE_BOARD_MIGRATION_LOCK = 270_020_001;

export interface BoardMigration {
  version: number;
  up(trx: Transaction<MessageBoardDatabase>): Promise<void>;
}

const v1: BoardMigration = {
  version: 1,
  async up(trx) {
    await sql`CREATE TABLE board_boards (
      id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
      scope text NOT NULL CHECK (scope IN ('personal','organization')),
      last_cursor bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`CREATE UNIQUE INDEX board_boards_owner_name ON board_boards(owner_id, lower(name))`.execute(trx);
    await sql`CREATE TABLE board_channels (
      owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      path text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY (board_id, path)
    )`.execute(trx);
    await sql`CREATE TABLE board_messages (
      id text PRIMARY KEY, seq bigserial NOT NULL, owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      channel text NOT NULL, root_id text REFERENCES board_messages(id), reply_to text,
      author text NOT NULL, author_actor jsonb NOT NULL, text text NOT NULL, mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
      revision integer NOT NULL DEFAULT 1, idempotency_key text,
      reply_count integer NOT NULL DEFAULT 0, last_activity_at timestamptz NOT NULL, last_actor text NOT NULL,
      created_at timestamptz NOT NULL, edited_at timestamptz, deleted_at timestamptz,
      FOREIGN KEY (board_id, channel) REFERENCES board_channels(board_id, path)
    )`.execute(trx);
    await sql`CREATE UNIQUE INDEX board_messages_idempotency ON board_messages(board_id, author, idempotency_key) WHERE idempotency_key IS NOT NULL`.execute(trx);
    await sql`CREATE INDEX board_messages_roots ON board_messages(board_id, channel, last_activity_at DESC) WHERE root_id IS NULL`.execute(trx);
    await sql`CREATE INDEX board_messages_replies ON board_messages(root_id, seq) WHERE root_id IS NOT NULL`.execute(trx);
    await sql`CREATE TABLE board_labels (
      owner_id text NOT NULL, message_id text NOT NULL REFERENCES board_messages(id) ON DELETE CASCADE,
      key text NOT NULL, value text NOT NULL, PRIMARY KEY (message_id, key)
    )`.execute(trx);
    await sql`CREATE INDEX board_labels_key_value ON board_labels(key, value)`.execute(trx);
    await sql`CREATE TABLE board_reactions (
      owner_id text NOT NULL, message_id text NOT NULL REFERENCES board_messages(id) ON DELETE CASCADE,
      actor text NOT NULL, emoji text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY (message_id, actor, emoji)
    )`.execute(trx);
    await sql`CREATE TABLE board_events (
      owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      cursor bigint NOT NULL, type text NOT NULL, actor jsonb NOT NULL, channel text, message_id text, thread_id text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL,
      PRIMARY KEY (board_id, cursor)
    )`.execute(trx);
    await sql`CREATE INDEX board_events_created ON board_events(created_at)`.execute(trx);
    await sql`CREATE TABLE board_reads (
      owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      actor text NOT NULL, root_id text NOT NULL REFERENCES board_messages(id) ON DELETE CASCADE,
      read_at timestamptz NOT NULL, PRIMARY KEY (board_id, actor, root_id)
    )`.execute(trx);
  },
};

const v2: BoardMigration = {
  version: 2,
  async up(trx) {
    await sql`CREATE TABLE board_tasks (
      root_id text PRIMARY KEY REFERENCES board_messages(id) ON DELETE CASCADE,
      owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE, channel text NOT NULL,
      state text NOT NULL CHECK (state IN ('waiting','ready','claimed','blocked','completed','failed','canceled')),
      owner_actor text NOT NULL, assigned_profile text, claim_holder jsonb, claim_epoch integer NOT NULL DEFAULT 0,
      claim_token_hash text, lease_until timestamptz, result text, failure_reason text, cancel_reason text,
      blocked_reason text, blocked_kind text, updated_at timestamptz NOT NULL,
      CHECK ((state = 'claimed') = (lease_until IS NOT NULL))
    )`.execute(trx);
    await sql`CREATE INDEX board_tasks_state ON board_tasks(board_id, state)`.execute(trx);
    await sql`CREATE INDEX board_tasks_lease ON board_tasks(lease_until) WHERE state = 'claimed'`.execute(trx);
    await sql`CREATE TABLE board_task_needs (
      owner_id text NOT NULL,
      task_id text NOT NULL REFERENCES board_tasks(root_id) ON DELETE CASCADE,
      needs_task_id text NOT NULL REFERENCES board_tasks(root_id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, needs_task_id), CHECK (task_id <> needs_task_id)
    )`.execute(trx);
    await sql`CREATE INDEX board_task_needs_reverse ON board_task_needs(needs_task_id)`.execute(trx);
  },
};

const v3: BoardMigration = {
  version: 3,
  async up(trx) {
    await sql`CREATE TABLE board_watchers (
      id text PRIMARY KEY, owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      name text NOT NULL, tail jsonb NOT NULL, action jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
      max_runs_per_hour integer NOT NULL CHECK (max_runs_per_hour BETWEEN 1 AND 120),
      created_by text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      UNIQUE (board_id, name)
    )`.execute(trx);
    await sql`CREATE TABLE board_watcher_runs (
      owner_id text NOT NULL, watcher_id text NOT NULL REFERENCES board_watchers(id) ON DELETE CASCADE,
      event_cursor bigint NOT NULL, message_id text NOT NULL,
      outcome text CHECK (outcome IN ('ok','failed')), attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL, last_error text, created_at timestamptz NOT NULL, finished_at timestamptz,
      PRIMARY KEY (watcher_id, event_cursor)
    )`.execute(trx);
    await sql`CREATE INDEX board_watcher_runs_pending ON board_watcher_runs(next_attempt_at) WHERE outcome IS NULL`.execute(trx);
    await sql`CREATE INDEX board_watcher_runs_recent ON board_watcher_runs(watcher_id, created_at)`.execute(trx);
    await sql`CREATE TABLE board_schedules (
      id text PRIMARY KEY, owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      author text NOT NULL, author_actor jsonb NOT NULL, channel text NOT NULL, thread_id text REFERENCES board_messages(id) ON DELETE CASCADE,
      text text NOT NULL, next_run_at timestamptz NOT NULL, every text, remaining integer, until_at timestamptz,
      run_count integer NOT NULL DEFAULT 0, origin jsonb, created_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`CREATE TABLE board_watcher_progress (
      owner_id text NOT NULL, board_id text PRIMARY KEY REFERENCES board_boards(id) ON DELETE CASCADE,
      cursor bigint NOT NULL, updated_at timestamptz NOT NULL
    )`.execute(trx);
    await sql`CREATE INDEX board_schedules_due ON board_schedules(next_run_at)`.execute(trx);
    await sql`CREATE TABLE board_grants (
      id text PRIMARY KEY, owner_id text NOT NULL, board_id text NOT NULL REFERENCES board_boards(id) ON DELETE CASCADE,
      principal text NOT NULL, pattern text NOT NULL, permissions jsonb NOT NULL,
      created_by text NOT NULL, created_at timestamptz NOT NULL,
      UNIQUE (board_id, principal, pattern)
    )`.execute(trx);
  },
};

export const MESSAGE_BOARD_MIGRATIONS: readonly BoardMigration[] = [v1, v2, v3];

/**
 * Applies pending versioned migrations in one transaction under an advisory
 * lock, so concurrent gateway starts cannot interleave. The caller owns the
 * Kysely instance and its pool.
 */
export async function bootstrapMessageBoardDatabase(
  db: Kysely<MessageBoardDatabase>,
  migrations: readonly BoardMigration[] = MESSAGE_BOARD_MIGRATIONS,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${MESSAGE_BOARD_MIGRATION_LOCK})`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS board_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)`.execute(trx);
    const applied = new Set((await trx.selectFrom("board_schema_migrations").select("version").execute()).map((row) => row.version));
    let latest = Math.max(0, ...applied);
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(migration.version)) continue;
      await migration.up(trx);
      await trx.insertInto("board_schema_migrations").values({ version: migration.version, applied_at: new Date() }).execute();
      latest = migration.version;
    }
    return latest;
  });
}
