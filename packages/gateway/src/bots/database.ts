/**
 * Owner bot state in the gateway's owner Postgres (spec 536, data-model.md).
 * Tables are created by versioned migrations; see database-migrations.ts.
 */
import { sql, type ColumnType, type Kysely } from "kysely";
import type { ChatDatabase } from "../chat/database.js";
import { BOT_MIGRATIONS, type BotMigration } from "./database-migrations.js";

type Timestamp = ColumnType<Date | string, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, T | string, T | string>;
type Revision = ColumnType<number | string, number | undefined, number>;

export type BotOperationStatus = "reserved" | "file_created" | "active" | "failed_recoverable";

export interface BotOperationsTable {
  owner_id: string;
  client_request_id: string;
  bot_id: string;
  chat_id: string;
  workspace_rel_path: string;
  payload_hash: string;
  status: BotOperationStatus;
  failure_code: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  revision: Revision;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotChatBindingsTable {
  owner_id: string;
  bot_id: string;
  chat_id: string;
  kind: "direct" | "group";
  created_at: Timestamp;
  removed_at: NullableTimestamp;
}

export interface BotAgentSessionsTable {
  session_id: string;
  owner_id: string;
  bot_id: string;
  chat_id: string;
  messages: Json<unknown[]>;
  compacted_through_seq: ColumnType<number | string | null, number | null | undefined, number | null>;
  token_estimate: ColumnType<number, number | undefined, number>;
  runtime_versions: Json<Record<string, string>>;
  needs_recompaction: ColumnType<boolean, boolean | undefined, boolean>;
  revision: ColumnType<number | string, number, number>;
  updated_at: Timestamp;
}

export type BotTaskStatus =
  | "queued" | "running" | "waiting_person" | "waiting_capacity" | "blocked" | "completed" | "failed" | "cancelled";

export interface BotTaskBudget {
  handoffs: number;
  depth: number;
  toolActions: number;
  microUsd: number;
}

export interface BotTasksTable {
  task_id: string;
  owner_id: string;
  bot_id: string;
  chat_id: string;
  parent_task_id: string | null;
  coordinator_bot_id: string | null;
  status: BotTaskStatus;
  run_id: string | null;
  budget: Json<BotTaskBudget>;
  active_ms: ColumnType<number | string, number | undefined, number>;
  running_since: NullableTimestamp;
  blocked_reason: string | null;
  revision: Revision;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type BotEffectClass = "read" | "write" | "send" | "computer";
export type BotCheckpointPhase = "prepared" | "dispatched" | "observed_complete" | "effect_unknown";

export interface BotToolCheckpointsTable {
  checkpoint_id: string;
  owner_id: string;
  task_id: string;
  run_id: string;
  tool_call_id: string;
  action: Json<Record<string, unknown>>;
  action_hash: string;
  effect_class: BotEffectClass;
  phase: BotCheckpointPhase;
  outcome_ref: string | null;
  read_retries: ColumnType<number, number | undefined, number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotInteractionsTable {
  interaction_id: string;
  owner_id: string;
  bot_id: string;
  chat_id: string;
  task_id: string;
  kind: "question" | "account_choice" | "connect_request" | "approval";
  payload: Json<Record<string, unknown>>;
  responder_actor_id: string;
  blocking: boolean;
  status: "pending" | "resolved" | "expired" | "cancelled";
  resolution: ColumnType<Record<string, unknown> | null, Record<string, unknown> | string | null, Record<string, unknown> | string | null>;
  expires_at: Timestamp;
  revision: Revision;
  created_at: Timestamp;
  resolved_at: NullableTimestamp;
}

export interface BotConnectRequestsTable {
  request_id: string;
  owner_id: string;
  interaction_id: string;
  service: string;
  requested_at: Timestamp;
  expires_at: Timestamp;
  baseline_connection_ids: Json<string[]>;
  status: "pending" | "completed" | "ambiguous" | "cancelled" | "expired";
  completed_connection_id: string | null;
  retry_after: NullableTimestamp;
  revision: Revision;
  updated_at: Timestamp;
}

export interface BotGrantsTable {
  grant_id: string;
  owner_id: string;
  bot_id: string;
  service: string;
  connection_id: string;
  account_label: string;
  effects: ColumnType<string[], string[], string[]>;
  audience: string;
  granted_by_actor_id: string;
  expires_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  revision: Revision;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotApprovalsTable {
  approval_id: string;
  owner_id: string;
  bot_id: string;
  /** The run that asked; the approval binds the task, so a continuation run can claim it. */
  run_id: string;
  task_id: string;
  tool: string;
  args_hash: string;
  account: string;
  audience: string;
  policy_revision: ColumnType<number | string, number, number>;
  status: "pending" | "approved" | "denied" | "expired" | "invalidated";
  claimed_at: NullableTimestamp;
  expires_at: Timestamp;
  revision: Revision;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotMemoryItemsTable {
  item_id: string;
  owner_id: string;
  bot_id: string;
  kind: "preference" | "fact" | "episode";
  scope: string;
  content: string;
  content_tsv: ColumnType<string, never, never>;
  source: Json<Record<string, unknown>>;
  confirmed: boolean;
  revision: Revision;
  created_at: Timestamp;
  updated_at: Timestamp;
  expires_at: NullableTimestamp;
  forgotten_at: NullableTimestamp;
}

export interface BotSchemaMigrationsTable {
  version: number;
  name: string;
  applied_at: ColumnType<Date | string, Date | string | undefined, never>;
}

export interface BotDatabase {
  bot_chatgpt_plan_devices: { owner_id: string; computer_id: string; device_id: string; public_key: string; };
  bot_provider_authorizations: {
    owner_id: string; computer_id: string; connection_id: 'claude_code_tasks'; fingerprint: string;
    enabled: boolean; background: boolean; revision: number | string;
  };
  bot_execution_bindings: {
    owner_id: string; computer_id: string; bot_id: string; connection_id: 'claude_code_tasks' | null;
    model: string | null; grant_revision: number | string | null; native_session_id: string | null; revision: number | string;
  };
  managed_pi_sessions: Omit<BotAgentSessionsTable, "bot_id">;
  managed_pi_tool_checkpoints: Omit<BotToolCheckpointsTable, "task_id"> & { chat_id: string };
  bot_schema_migrations: BotSchemaMigrationsTable;
  bot_operations: BotOperationsTable;
  bot_chat_bindings: BotChatBindingsTable;
  bot_agent_sessions: BotAgentSessionsTable;
  bot_tasks: BotTasksTable;
  bot_tool_checkpoints: BotToolCheckpointsTable;
  bot_interactions: BotInteractionsTable;
  bot_connect_requests: BotConnectRequestsTable;
  bot_grants: BotGrantsTable;
  bot_approvals: BotApprovalsTable;
  bot_memory_items: BotMemoryItemsTable;
}

export type OwnerBotDatabase = ChatDatabase & BotDatabase;

export class BotSchemaError extends Error {
  constructor(readonly code: "invalid_migrations" | "newer_schema") {
    super(code === "newer_schema"
      ? "Bot state was migrated by a newer build"
      : "Bot migrations are misconfigured");
    this.name = "BotSchemaError";
  }
}

function assertOrdered(migrations: readonly BotMigration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version !== previous + 1
      || !/^[a-z][a-z0-9_]{0,63}$/.test(migration.name)) {
      throw new BotSchemaError("invalid_migrations");
    }
    previous = migration.version;
  }
}

/**
 * Applies pending bot migrations. Each version runs in its own transaction
 * under a schema advisory lock, so concurrent gateways apply it once, and a
 * failed version rolls back without undoing earlier ones. Requires the chat
 * schema to exist. Refuses a database migrated by a newer build.
 */
export async function bootstrapBotDatabase(
  db: Kysely<OwnerBotDatabase>,
  migrations: readonly BotMigration[] = BOT_MIGRATIONS,
): Promise<{ applied: number[] }> {
  assertOrdered(migrations);
  await sql`
    CREATE TABLE IF NOT EXISTS bot_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  const applied: number[] = [];
  for (const migration of migrations) {
    const ran = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix-bot-schema', 0))`.execute(trx);
      const existing = await trx.selectFrom("bot_schema_migrations")
        .select("version").where("version", "=", migration.version).executeTakeFirst();
      if (existing) return false;
      await migration.up(trx);
      await trx.insertInto("bot_schema_migrations").values({ version: migration.version, name: migration.name }).execute();
      return true;
    });
    if (ran) applied.push(migration.version);
  }
  const newest = await db.selectFrom("bot_schema_migrations")
    .select((eb) => eb.fn.max("version").as("version")).executeTakeFirst();
  if (Number(newest?.version ?? 0) > (migrations.at(-1)?.version ?? 0)) throw new BotSchemaError("newer_schema");
  return { applied };
}
