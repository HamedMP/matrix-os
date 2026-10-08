import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import pg from "pg";
import { bootstrapChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";

export const OWNER = "user_owner_1";
export const OTHER_OWNER = "user_owner_2";
export const BOT = "bot_0123456789abcdef";
export const NOW = "2026-09-27T12:00:00.000Z";

export function at(offsetMs: number): string {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

/** A real Postgres (PGlite) with the chat and bot schemas applied. */
export async function createBotStateDatabase(options: { migrate?: boolean } = {}) {
  const instance = await KyselyPGlite.create();
  const db = new Kysely<OwnerBotDatabase>({ dialect: instance.dialect });
  await bootstrapChatDatabase(db);
  if (options.migrate !== false) await bootstrapBotDatabase(db);
  return { db, destroy: () => db.destroy() };
}

export async function insertChat(db: Kysely<OwnerBotDatabase>, id: string, ownerId = OWNER): Promise<void> {
  await db.insertInto("chats").values({
    id,
    owner_type: "personal",
    owner_id: ownerId,
    create_request_id: `req_${id.slice("chat_".length)}`,
    project_id: null,
    title: "Bot chat",
    lifecycle: "active",
    attention: "none",
    collaboration: null,
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: NOW,
    updated_at: NOW,
  }).execute();
}

/**
 * A real Postgres schema with several pooled connections, for tests that
 * need true concurrency (PGlite runs every transaction on one session).
 * Requires MATRIX_TEST_POSTGRES_URL naming a dedicated test database.
 */
export async function createRealBotStateDatabase(connectionString = process.env.MATRIX_TEST_POSTGRES_URL) {
  if (!connectionString) throw new Error("MATRIX_TEST_POSTGRES_URL is required");
  if (!new URL(connectionString).pathname.toLowerCase().includes("test")) {
    throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
  }
  const schema = `bots_${randomUUID().replaceAll("-", "")}`;
  const admin = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  const db = new Kysely<OwnerBotDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` }),
    }),
  });
  await bootstrapChatDatabase(db);
  await bootstrapBotDatabase(db);
  return {
    db,
    destroy: async () => {
      await db.destroy();
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);
      await admin.destroy();
    },
  };
}
