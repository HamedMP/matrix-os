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

export interface MessageBoardDatabase {
  board_schema_migrations: BoardSchemaMigrationsTable;
  board_boards: BoardBoardsTable;
  board_channels: BoardChannelsTable;
  board_messages: BoardMessagesTable;
  board_labels: BoardLabelsTable;
  board_reactions: BoardReactionsTable;
  board_events: BoardEventsTable;
  board_reads: BoardReadsTable;
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

export const MESSAGE_BOARD_MIGRATIONS: readonly BoardMigration[] = [v1];

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
