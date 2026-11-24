/**
 * Owner Postgres schema for the project task board (spec 2699 section 1).
 * Versioned migrations run once each, in order, inside a transaction that holds
 * the `matrix-project-task-schema` advisory lock, so concurrent gateways apply
 * a version exactly once. Every row carries `owner_id` and every unique index
 * includes it; CHECK constraints mirror the contract's Zod bounds.
 */
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { TASK_LIMITS } from "@matrix-os/contracts/project-tasks";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type Revision = ColumnType<number | string, number | undefined, number>;
type Json<T> = ColumnType<T, T | string, T | string>;

export interface BoardAutomationColumn {
  startMovesToInProgress: boolean;
  prOpenMovesToReview: boolean;
  prMergeMovesToDone: boolean;
}

export interface ProjectTaskDatabase {
  project_task_schema_migrations: { version: number; name: string; applied_at: ColumnType<Date | string, never, never> };
  project_board_settings: {
    owner_id: string;
    project_id: string;
    task_key: string;
    next_number: Revision;
    automation: Json<BoardAutomationColumn>;
    legacy_import_at: NullableTimestamp;
    chats_linked_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  project_tasks: {
    owner_id: string;
    id: string;
    project_id: string;
    number: Revision;
    title: string;
    description: string;
    status: string;
    priority: string;
    rank: string;
    assignee: string | null;
    labels: ColumnType<string[], string[] | undefined, string[]>;
    parent_task_id: string | null;
    due_at: NullableTimestamp;
    worktree_id: string | null;
    branch: string | null;
    pr_number: ColumnType<number | null, number | null | undefined, number | null>;
    pr_state: ColumnType<string | null, string | null | undefined, string | null>;
    pr_checks: ColumnType<string | null, string | null | undefined, string | null>;
    pr_review: ColumnType<string | null, string | null | undefined, string | null>;
    pr_url: ColumnType<string | null, string | null | undefined, string | null>;
    pr_refreshed_at: NullableTimestamp;
    legacy_session_id: string | null;
    chat_id: ColumnType<string | null, string | null | undefined, string | null>;
    comment_count: Revision;
    created_by: string;
    created_at: Timestamp;
    updated_at: Timestamp;
    revision: Revision;
    archived_at: NullableTimestamp;
    deleted_at: NullableTimestamp;
  };
  project_task_activity: {
    owner_id: string;
    seq: ColumnType<number | string, never, never>;
    project_id: string;
    task_id: string;
    actor: string;
    kind: string;
    summary: string;
    created_at: Timestamp;
  };
  project_task_relations: {
    owner_id: string;
    task_id: string;
    blocked_by_task_id: string;
    created_at: Timestamp;
  };
  project_task_comments: {
    owner_id: string;
    id: string;
    project_id: string;
    task_id: string;
    author: string;
    body: string;
    created_at: Timestamp;
    edited_at: NullableTimestamp;
    deleted_at: NullableTimestamp;
  };
  project_task_sessions: {
    owner_id: string;
    task_id: string;
    session_ref: string;
    kind: string;
    title: string;
    role: string;
    harness: string | null;
    start_request_id: string | null;
    created_by: string;
    created_at: Timestamp;
  };
  project_task_operations: {
    owner_id: string;
    client_request_id: string;
    project_id: string;
    payload_hash: string;
    task_id: string | null;
    created_at: Timestamp;
  };
}

export type ProjectTaskDb = Kysely<ProjectTaskDatabase>;
/** A transaction, or a connection already inside one (a chat transaction the board joins). */
export type ProjectTaskTrx = Transaction<ProjectTaskDatabase> | Kysely<ProjectTaskDatabase>;

const OWNER = "owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128)";
const TASK_ID = (column: string) => `${column} TEXT NOT NULL CHECK (${column} ~ '^task_[A-Za-z0-9_-]{1,128}$')`;
const PROJECT_ID = "project_id TEXT NOT NULL CHECK (project_id ~ '^proj_[A-Za-z0-9_-]{1,128}$')";
const ACTOR = (column: string, nullable = false) =>
  `${column} TEXT ${nullable ? "" : "NOT NULL"} CHECK (${column} ~ '^(user|agent|system):[A-Za-z0-9_.:@-]{1,190}$')`;

async function migrateProjectTasksV1(trx: ProjectTaskTrx): Promise<void> {
  await sql.raw(`
    CREATE TABLE project_board_settings (
      ${OWNER},
      ${PROJECT_ID},
      task_key TEXT NOT NULL CHECK (task_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
      next_number BIGINT NOT NULL DEFAULT 1 CHECK (next_number > 0),
      automation JSONB NOT NULL CHECK (jsonb_typeof(automation) = 'object' AND octet_length(automation::text) <= 512),
      legacy_import_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, project_id)
    )
  `).execute(trx);
  await sql.raw(`
    CREATE TABLE project_tasks (
      ${OWNER},
      ${TASK_ID("id")},
      ${PROJECT_ID},
      number BIGINT NOT NULL CHECK (number > 0),
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND ${TASK_LIMITS.title}),
      description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= ${TASK_LIMITS.description}),
      status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled')),
      priority TEXT NOT NULL CHECK (priority IN ('none', 'low', 'normal', 'high', 'urgent')),
      rank TEXT COLLATE "C" NOT NULL CHECK (rank ~ '^[0-9A-Za-z]*[1-9A-Za-z]$' AND char_length(rank) <= ${TASK_LIMITS.rank}),
      ${ACTOR("assignee", true)},
      labels TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(labels) <= ${TASK_LIMITS.labels}),
      parent_task_id TEXT CHECK (parent_task_id ~ '^task_[A-Za-z0-9_-]{1,128}$'),
      due_at TIMESTAMPTZ,
      worktree_id TEXT CHECK (char_length(worktree_id) BETWEEN 1 AND 140),
      branch TEXT CHECK (char_length(branch) BETWEEN 1 AND 200),
      pr_number INTEGER CHECK (pr_number > 0),
      legacy_session_id TEXT CHECK (legacy_session_id ~ '^sess_[A-Za-z0-9_-]{1,128}$'),
      comment_count INTEGER NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
      ${ACTOR("created_by")},
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      archived_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      PRIMARY KEY (owner_id, id),
      UNIQUE (owner_id, project_id, number),
      CHECK (parent_task_id IS NULL OR parent_task_id <> id)
    )
  `).execute(trx);
  await sql`
    CREATE INDEX idx_project_tasks_board ON project_tasks(owner_id, project_id, status, rank)
    WHERE deleted_at IS NULL
  `.execute(trx);
  await sql`
    CREATE INDEX idx_project_tasks_parent ON project_tasks(owner_id, parent_task_id)
    WHERE deleted_at IS NULL AND parent_task_id IS NOT NULL
  `.execute(trx);
  await sql.raw(`
    CREATE TABLE project_task_activity (
      ${OWNER},
      seq BIGINT GENERATED ALWAYS AS IDENTITY,
      ${PROJECT_ID},
      ${TASK_ID("task_id")},
      ${ACTOR("actor")},
      kind TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z_]{1,31}$'),
      summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 400),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, seq)
    )
  `).execute(trx);
  await sql`CREATE INDEX idx_project_task_activity_task ON project_task_activity(owner_id, task_id, seq)`.execute(trx);
  await sql`CREATE INDEX idx_project_task_activity_age ON project_task_activity(created_at)`.execute(trx);
  await sql.raw(`
    CREATE TABLE project_task_operations (
      ${OWNER},
      client_request_id TEXT NOT NULL CHECK (client_request_id ~ '^req_[A-Za-z0-9_-]{1,128}$'),
      ${PROJECT_ID},
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
      task_id TEXT CHECK (task_id ~ '^task_[A-Za-z0-9_-]{1,128}$'),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, client_request_id)
    )
  `).execute(trx);
  await sql`CREATE INDEX idx_project_task_operations_age ON project_task_operations(created_at)`.execute(trx);
}

async function migrateTaskCommentsV2(trx: ProjectTaskTrx): Promise<void> {
  await sql.raw(`
    CREATE TABLE project_task_relations (
      ${OWNER},
      ${TASK_ID("task_id")},
      ${TASK_ID("blocked_by_task_id")},
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, task_id, blocked_by_task_id),
      CHECK (task_id <> blocked_by_task_id)
    )
  `).execute(trx);
  await sql`CREATE INDEX idx_project_task_relations_blocker ON project_task_relations(owner_id, blocked_by_task_id)`.execute(trx);
  await sql.raw(`
    CREATE TABLE project_task_comments (
      ${OWNER},
      id TEXT NOT NULL CHECK (id ~ '^tcm_[A-Za-z0-9_-]{1,128}$'),
      ${PROJECT_ID},
      ${TASK_ID("task_id")},
      ${ACTOR("author")},
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND ${TASK_LIMITS.comment}),
      created_at TIMESTAMPTZ NOT NULL,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      PRIMARY KEY (owner_id, id)
    )
  `).execute(trx);
  await sql`
    CREATE INDEX idx_project_task_comments_task ON project_task_comments(owner_id, task_id, created_at, id)
    WHERE deleted_at IS NULL
  `.execute(trx);
}

async function migrateTaskSessionsV3(trx: ProjectTaskTrx): Promise<void> {
  await sql.raw(`
    CREATE TABLE project_task_sessions (
      ${OWNER},
      ${TASK_ID("task_id")},
      session_ref TEXT NOT NULL CHECK (session_ref ~ '^(chat_[A-Za-z0-9_-]{1,128}|term\\.[A-Za-z0-9_-]{1,128}\\.[A-Za-z0-9_-]{1,128})$'),
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'terminal')),
      title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
      role TEXT NOT NULL CHECK (role IN ('main', 'extra')),
      harness TEXT CHECK (harness ~ '^[a-z][a-z0-9-]{0,39}$'),
      start_request_id TEXT CHECK (start_request_id ~ '^req_[A-Za-z0-9_-]{1,128}$'),
      ${ACTOR("created_by")},
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (owner_id, task_id, session_ref),
      UNIQUE (owner_id, session_ref),
      UNIQUE (owner_id, task_id, start_request_id),
      CHECK ((kind = 'chat') = (left(session_ref, 5) = 'chat_'))
    )
  `).execute(trx);
  await sql`
    CREATE UNIQUE INDEX idx_project_task_sessions_main ON project_task_sessions(owner_id, task_id) WHERE role = 'main'
  `.execute(trx);
  await sql.raw(`
    ALTER TABLE project_tasks
      ADD COLUMN pr_state TEXT CHECK (pr_state IN ('open', 'draft', 'merged', 'closed')),
      ADD COLUMN pr_checks TEXT CHECK (pr_checks IN ('passing', 'failing', 'pending', 'none')),
      ADD COLUMN pr_review TEXT CHECK (pr_review IN ('approved', 'changes_requested', 'review_required', 'none')),
      ADD COLUMN pr_url TEXT CHECK (char_length(pr_url) BETWEEN 1 AND 500 AND pr_url ~ '^https://'),
      ADD COLUMN pr_refreshed_at TIMESTAMPTZ,
      ADD CONSTRAINT project_tasks_pr_summary CHECK (
        (pr_state IS NULL AND pr_checks IS NULL AND pr_review IS NULL AND pr_url IS NULL)
        OR (pr_state IS NOT NULL AND pr_checks IS NOT NULL AND pr_review IS NOT NULL AND pr_url IS NOT NULL AND pr_number IS NOT NULL)
      )
  `).execute(trx);
}

/**
 * Every task is a chat (spec 2699 amendment): each task links its one chat, a
 * chat links at most one task, and task sessions hold terminals only. A task's
 * first chat link (from earlier previews) becomes its chat.
 */
async function migrateTaskChatsV4(trx: ProjectTaskTrx): Promise<void> {
  const statements = [
    `ALTER TABLE project_tasks ADD COLUMN chat_id TEXT CHECK (chat_id ~ '^chat_[A-Za-z0-9_-]{1,128}$')`,
    `ALTER TABLE project_board_settings ADD COLUMN chats_linked_at TIMESTAMPTZ`,
    `UPDATE project_tasks AS task SET chat_id = link.session_ref
    FROM (
      SELECT DISTINCT ON (owner_id, task_id) owner_id, task_id, session_ref
      FROM project_task_sessions WHERE kind = 'chat'
      ORDER BY owner_id, task_id, (role = 'main') DESC, created_at ASC, session_ref ASC
    ) AS link
    WHERE task.owner_id = link.owner_id AND task.id = link.task_id AND task.chat_id IS NULL`,
    `DELETE FROM project_task_sessions WHERE kind = 'chat'`,
    `ALTER TABLE project_task_sessions ADD CONSTRAINT project_task_sessions_terminal_only CHECK (kind = 'terminal')`,
    `CREATE UNIQUE INDEX idx_project_tasks_chat ON project_tasks(owner_id, chat_id) WHERE chat_id IS NOT NULL`,
  ];
  for (const statement of statements) await sql.raw(statement).execute(trx);
}

export interface ProjectTaskMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (trx: ProjectTaskTrx) => Promise<void>;
}

/** Applied in order; never edit a released version, add a new one. */
export const PROJECT_TASK_MIGRATIONS: ProjectTaskMigration[] = [
  { version: 1, name: "project_tasks", up: migrateProjectTasksV1 },
  { version: 2, name: "task_comments_relations", up: migrateTaskCommentsV2 },
  { version: 3, name: "task_sessions_pull_requests", up: migrateTaskSessionsV3 },
  { version: 4, name: "task_chats", up: migrateTaskChatsV4 },
];

export class ProjectTaskSchemaError extends Error {
  constructor(readonly code: "newer_schema" | "unordered_migrations") {
    super(code);
    this.name = "ProjectTaskSchemaError";
  }
}

function lock(trx: ProjectTaskTrx) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix-project-task-schema', 0))`.execute(trx);
}

/** Bring the owner database up to the newest board schema this gateway knows. */
export async function bootstrapProjectTaskDatabase(
  db: ProjectTaskDb,
  migrations: readonly ProjectTaskMigration[] = PROJECT_TASK_MIGRATIONS,
): Promise<{ applied: number[] }> {
  if (migrations.some((migration, index) => migration.version !== index + 1)) throw new ProjectTaskSchemaError("unordered_migrations");
  // Under the schema lock: two first-time gateways must not race on CREATE TABLE IF NOT EXISTS.
  await db.transaction().execute(async (trx) => {
    await lock(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS project_task_schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(trx);
  });
  const applied: number[] = [];
  for (const migration of migrations) {
    const ran = await db.transaction().execute(async (trx) => {
      await lock(trx);
      const newest = await trx.selectFrom("project_task_schema_migrations").select(sql<number>`max(version)`.as("version")).executeTakeFirst();
      if (Number(newest?.version ?? 0) > migrations.length) throw new ProjectTaskSchemaError("newer_schema");
      const existing = await trx.selectFrom("project_task_schema_migrations").select("version")
        .where("version", "=", migration.version).executeTakeFirst();
      if (existing) return false;
      await migration.up(trx);
      await trx.insertInto("project_task_schema_migrations").values({ version: migration.version, name: migration.name }).execute();
      return true;
    });
    if (ran) applied.push(migration.version);
  }
  return { applied };
}
