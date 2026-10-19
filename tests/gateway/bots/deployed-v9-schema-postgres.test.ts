import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotSchemaError, bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { bootstrapChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { BOT, NOW, OWNER, insertChat } from "./bot-state-support.js";
import { migrateDeployedBotThreadsV9 } from "./fixtures/bot-threads-schema-v9.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("released v9 pooled startup compatibility", () => {
  let db: Kysely<OwnerBotDatabase>, admin: Kysely<Record<string, never>>, schema: string;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.toLowerCase().includes("test")) throw new Error("Dedicated test database required");
    schema = `bots_v9_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 8,
      options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` }) }) });
    await bootstrapChatDatabase(db); await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 8));
  });
  afterEach(async () => { await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); });
  const concurrentStarts = () => Promise.all(Array.from({ length: 12 }, () => bootstrapBotDatabase(db)));
  const rows = async (table: string) => (await sql`SELECT * FROM ${sql.table(table)} ORDER BY 1, 2`.execute(db)).rows;

  it("applies exact v9 once across twelve pooled v8 startups and preserves existing direct data", async () => {
    await insertChat(db, "chat_v8_saved");
    await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,created_at) VALUES (${OWNER},${BOT},'chat_v8_saved','direct',${NOW})`.execute(db);
    const chats = await rows("chats");
    expect((await concurrentStarts()).flatMap(result => result.applied)).toEqual([9]);
    expect((await concurrentStarts()).every(result => result.applied.length === 0)).toBe(true);
    expect(await rows("chats")).toEqual(chats);
    expect(await db.selectFrom("bot_chat_bindings").select(["kind", "project_id"]).execute()).toEqual([{ kind: "direct", project_id: null }]);
    expect(await db.selectFrom("bot_schema_migrations").select(["version", "name"]).where("version", "=", 9).execute())
      .toEqual([{ version: 9, name: "bot_chat_threads" }]);
  });

  it("retains multi-owner deployed v9 threads, fixed projects and historical messages through concurrent startup", async () => {
    await db.transaction().execute(async trx => {
      await migrateDeployedBotThreadsV9(trx);
      await trx.insertInto("bot_schema_migrations").values({ version: 9, name: "bot_chat_threads" }).execute();
    });
    for (const [index, ownerId] of [OWNER, "other_owner"].entries()) {
      const chatId = `chat_thread_${index}`; await insertChat(db, chatId, ownerId);
      await db.updateTable("chats").set({ project_id: `proj_saved_${index}` }).where("id", "=", chatId).execute();
      await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,project_id,created_at)
        VALUES (${ownerId},${BOT},${chatId},'thread',${`proj_saved_${index}`},${NOW})`.execute(db);
      await db.insertInto("chat_messages").values({ id: `msg_saved_${index}`, chat_id: chatId, seq: 1, role: "user", purpose: "discussion",
        state: "committed", turn_id: null, run_id: null, actor_id: ownerId, parts: JSON.stringify([{ type: "text", text: "Retained thread history" }]),
        byte_count: 23, search_text: "Retained thread history", created_at: NOW }).execute();
    }
    const tables = ["bot_schema_migrations", "bot_chat_bindings", "chats", "chat_messages"];
    const before = await Promise.all(tables.map(rows));
    expect((await concurrentStarts()).every(result => result.applied.length === 0)).toBe(true);
    expect(await Promise.all(tables.map(rows))).toEqual(before);
    await expect(sql`UPDATE bot_chat_bindings SET project_id=NULL WHERE kind='thread'`.execute(db)).rejects.toThrow();
    await expect(sql`UPDATE bot_chat_bindings SET project_id='invalid' WHERE kind='thread'`.execute(db)).rejects.toThrow();
    expect(await Promise.all(tables.map(rows))).toEqual(before);
  });

  it.each([[9, "wrong_thread_feature", "invalid_migrations"], [10, "unknown_future", "newer_schema"]] as const)("rejects recorded %i/%s before missing DDL", async (version, name, code) => {
    // Missing earlier records make any accidental migration loop write observable.
    await db.deleteFrom("bot_schema_migrations").where("version", ">", 1).execute();
    await db.insertInto("bot_schema_migrations").values({ version, name }).execute();
    const before = await rows("bot_schema_migrations");
    await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError(code));
    expect(await rows("bot_schema_migrations")).toEqual(before);
    expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='bot_chat_bindings' AND column_name='project_id'`.execute(db)).rows).toEqual([]);
  });
});
