import { afterEach, expect, it } from "vitest";
import { sql } from "kysely";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { bootstrapBotDatabase, BotSchemaError } from "../../../packages/gateway/src/bots/database.js";
import { historicalV9Migrations } from "./deployed-v9-postgres-support.js";
import { createBotStateDatabase } from "./bot-state-support.js";
let data: Awaited<ReturnType<typeof createBotStateDatabase>> | undefined;
afterEach(async () => { await data?.destroy(); data = undefined; });
async function legacy() {
  data = await createBotStateDatabase({ migrate: false });
  await bootstrapBotDatabase(data.db, historicalV9Migrations());
  return data.db;
}
it("upgrades genuine frozen thread-v9 without relabeling any historical row", async () => {
  const db = await legacy();
  const before = await db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
  expect(await bootstrapBotDatabase(db)).toEqual({ applied: [10,11,12,13,14,15] });
  expect(await db.selectFrom("bot_schema_migrations").selectAll().where("version","<=",9).orderBy("version").execute()).toEqual(before);
  expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='bot_interactions' AND column_name='source_run_id'`.execute(db)).rows).toHaveLength(1);
  expect(await bootstrapBotDatabase(db)).toEqual({ applied: [] });
});
it("bridges canonical question-v9 additively into thread support then routines", async () => {
  data = await createBotStateDatabase({ migrate:false });
  await bootstrapBotDatabase(data.db,BOT_MIGRATIONS.slice(0,9));
  const before = await data.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
  expect(await bootstrapBotDatabase(data.db)).toEqual({ applied:[10,11,12,13,14,15] });
  expect(await data.db.selectFrom("bot_schema_migrations").selectAll().where("version","<=",9).orderBy("version").execute()).toEqual(before);
  expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='bot_chat_bindings' AND column_name='project_id'`.execute(data.db)).rows).toHaveLength(1);
});
it("rejects forged legacy identity before pending DDL if the retained thread invariant is missing", async () => {
  const db=await legacy();await sql`ALTER TABLE bot_chat_bindings DROP CONSTRAINT bot_chat_bindings_thread_project`.execute(db);
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
  expect((await db.selectFrom("bot_schema_migrations").select("version").execute()).length).toBe(9);
});

it("rejects unpublished old routine-v10 history without renumbering it", async () => {
 const db=await legacy();await db.insertInto("bot_schema_migrations").values({version:10,name:"bot_routines"}).execute();
 const before=await db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
 await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
 expect(await db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute()).toEqual(before);
});
it("refuses altered canonical question-v9 before adding thread columns", async () => {
 data=await createBotStateDatabase({migrate:false});await bootstrapBotDatabase(data.db,BOT_MIGRATIONS.slice(0,9));
 await sql`ALTER TABLE bot_interactions DROP CONSTRAINT bot_interactions_source_run_id_check`.execute(data.db);
 await expect(bootstrapBotDatabase(data.db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
 expect((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='bot_chat_bindings' AND column_name='project_id'`.execute(data.db)).rows).toHaveLength(0);
});
