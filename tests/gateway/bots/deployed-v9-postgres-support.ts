/** Inert until an explicitly enabled real-PG test calls this factory. No PGlite fallback. */
import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { BOT_MIGRATIONS, type BotMigration } from "../../../packages/gateway/src/bots/database-migrations.js";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { bootstrapChatDatabase, type ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { BOT, NOW, OWNER, insertChat } from "./bot-state-support.js";
import { migrateDeployedProviderConnectionsV5 } from "./fixtures/provider-schema-v5.js";
import { migrateDeployedChatGptPlanDevicesV6 } from "./fixtures/provider-schema-v6.js";
import { migrateDeployedBotChatThreadsV9 } from "./fixtures/provider-schema-v9.js";

export { BOT, NOW, OWNER };
export const V9_DIRECT = "chat_deployed_v9_direct";
export const V9_THREAD = "chat_deployed_v9_thread";
export const V9_ORDINARY = "chat_deployed_v9_ordinary";
export const V9_PROJECT = "proj_deployed_v9";
export const v9PgEnabled = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);

// v1-v4/v7-v8 remain canonical predecessor migrations. Only v5, v6 and v9 use
// independent released fixtures. Never substitute the current production v9.
export function historicalV9Migrations(): readonly BotMigration[] {
  return [
    ...BOT_MIGRATIONS.slice(0, 4),
    { version: 5, name: "bot_provider_connections", up: migrateDeployedProviderConnectionsV5 },
    { version: 6, name: "bot_chatgpt_plan_devices", up: migrateDeployedChatGptPlanDevicesV6 },
    ...BOT_MIGRATIONS.slice(6, 8),
    { version: 9, name: "bot_chat_threads", up: migrateDeployedBotChatThreadsV9 },
  ];
}

export async function createDeployedV9Fixture(version: 8 | 9 = 9) {
  const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
  if (!connectionString || !new URL(connectionString).pathname.toLowerCase().includes("test")) {
    throw new Error("A dedicated PostgreSQL test database is required");
  }
  const schema = `bots_v9_${randomUUID().replaceAll("-", "")}`;
  const admin = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
  let db: Kysely<OwnerBotDatabase> | undefined;
  let schemaCreated = false;
  async function destroy() {
    const failures: unknown[] = [];
    if (db) {
      try { await db.destroy(); } catch (error: unknown) { failures.push(error); }
    }
    if (schemaCreated) {
      try { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); }
      catch (error: unknown) { failures.push(error); }
    }
    try { await admin.destroy(); } catch (error: unknown) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "PG v9 fixture cleanup failed");
  }
  try {
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    schemaCreated = true;
    db = new Kysely<OwnerBotDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 8,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` }) }) });
    await bootstrapChatDatabase(db);
    await bootstrapBotDatabase(db, historicalV9Migrations().slice(0, version));
    await db.transaction().execute(async trx => {
      for (const id of [V9_DIRECT, V9_THREAD, V9_ORDINARY]) await insertChat(trx, id);
      await createBotBindingsRepository(trx).bindDirect({ ownerId: OWNER, botId: BOT, chatId: V9_DIRECT, now: NOW });
      await createBotGrantsRepository(trx).grant({ ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_v9_fixture",
        accountLabel: "Synthetic retained account", effects: ["read"], audience: "direct", grantedByActorId: OWNER, now: NOW });
      await sql`INSERT INTO bot_provider_authorizations VALUES (${OWNER}, 'computer_saved', 'claude_code_tasks', 'v9-fixture-fingerprint', true, false, 7)`.execute(trx);
      await sql`INSERT INTO bot_execution_bindings VALUES (${OWNER}, 'computer_saved', ${BOT}, 'claude_code_tasks', 'sonnet', 7, 'fixture_native_session', 4)`.execute(trx);
      for (const [owner, computer, digit] of [[OWNER, "computer_saved", "a"], [OWNER, "computer_other", "b"], ["other_owner", "computer_saved", "c"]]) {
        await sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${owner}, ${computer}, ${digit.repeat(64)}, ${"fixture-public-key-" + digit.repeat(32)})`.execute(trx);
      }
      await trx.insertInto("chat_messages").values({ id: "msg_v9_historical", chat_id: V9_THREAD, seq: 1, role: "user", purpose: "discussion",
        state: "committed", turn_id: null, run_id: null, actor_id: OWNER, parts: JSON.stringify([{ type: "text", text: "Retained synthetic history" }]),
        byte_count: 26, search_text: "Retained synthetic history", created_at: NOW }).execute();
      await trx.updateTable("chats").set({ message_count: 1 })
        .where("id", "=", V9_THREAD).where("owner_id", "=", OWNER).execute();
      if (version === 9) await sql`INSERT INTO bot_chat_bindings (owner_id, bot_id, chat_id, kind, project_id, created_at, removed_at)
        VALUES (${OWNER}, ${BOT}, ${V9_THREAD}, 'thread', ${V9_PROJECT}, ${NOW}, NULL)`.execute(trx);
    });
    const database = db;
    const chats = new ChatRepository(database as unknown as Kysely<ChatDatabase>);
    async function snapshot() {
      const tables = ["bot_chatgpt_plan_devices", "bot_provider_authorizations", "bot_execution_bindings", "bot_grants", "bot_chat_bindings", "chats", "chat_messages"];
      const rows = await Promise.all(tables.map(async table => [table,
        (await sql`SELECT * FROM ${sql.table(table)} ORDER BY 1, 2`.execute(database)).rows] as const));
      const history = await database.selectFrom("bot_schema_migrations").selectAll().where("version", "<=", 9).orderBy("version").execute();
      return { rows: Object.fromEntries(rows), history };
    }
    return { db: database, chats, snapshot, destroy };
  } catch (error: unknown) {
    try { await destroy(); } catch (cleanupError: unknown) {
      console.warn("[v9 test fixture] setup cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError");
    }
    throw error;
  }
}

export type DeployedV9Fixture = Awaited<ReturnType<typeof createDeployedV9Fixture>>;
