/** Native pooled PG only: both v9 histories, immutable records, and bridge rollback. */
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { bootstrapBotDatabase, BotSchemaError } from "../../../packages/gateway/src/bots/database.js";
import { historicalV9Migrations, createDeployedV9Fixture, v9PgEnabled, type DeployedV9Fixture } from "./deployed-v9-postgres-support.js";
// Frozen Main #2948 SQL, independent of the production bridge and registry function.
const questionV9 = { version:9, name:"question_source_run", up:async (db: Parameters<typeof BOT_MIGRATIONS[0]["up"]>[0]) => {
  await sql`ALTER TABLE bot_interactions ADD COLUMN source_run_id TEXT
    CHECK (source_run_id IS NULL OR source_run_id ~ '^run_[A-Za-z0-9_-]{1,128}$')`.execute(db);
} };
describe.skipIf(!v9PgEnabled)("pooled dual-v9 bridge",()=>{
 let fixture:DeployedV9Fixture|undefined;
 afterEach(async()=>{await fixture?.destroy();fixture=undefined;});
 const columns=async()=> (await sql<{column_name:string}>`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
   AND table_name='bot_interactions' AND column_name='source_run_id'`.execute(fixture!.db)).rows;
 it("concurrent canonical question-v9 starts apply bridge/routines once and preserve retained owner data",async()=>{
  fixture=await createDeployedV9Fixture(8);
  await bootstrapBotDatabase(fixture.db,[...historicalV9Migrations().slice(0,8),questionV9]);
  const before=await fixture.snapshot();
  const results=await Promise.all(Array.from({length:8},()=>bootstrapBotDatabase(fixture!.db)));
  expect(results.flatMap(r=>r.applied).sort()).toEqual([10,11,12,13,14,15]);
  const after=await fixture.snapshot();
  expect(after.history).toEqual(before.history);
  expect(after.rows).toEqual({...before.rows,bot_chat_bindings:before.rows.bot_chat_bindings!.map(r=>Object.assign({},r,{project_id:null}))});
  expect(await columns()).toHaveLength(1);
 });
 it("rejects incomplete legacy invariants before applying source or routine DDL",async()=>{
  fixture=await createDeployedV9Fixture();
  await sql`DROP INDEX idx_bot_chat_bindings_threads`.execute(fixture.db);
  const before=await fixture.snapshot();
  await expect(bootstrapBotDatabase(fixture.db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
  expect(await fixture.snapshot()).toEqual(before);expect(await columns()).toHaveLength(0);
 });
 it("does not relabel an old unpublished routine-v10 history",async()=>{
  fixture=await createDeployedV9Fixture();await fixture.db.insertInto("bot_schema_migrations").values({version:10,name:"bot_routines"}).execute();
  const before=await fixture.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
  await expect(bootstrapBotDatabase(fixture.db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
  expect(await fixture.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute()).toEqual(before);
  expect(await columns()).toHaveLength(0);
 });
 it("rolls back bridge DDL and history together and allows a clean retry",async()=>{
  fixture=await createDeployedV9Fixture();const before=await fixture.snapshot();
  const broken=BOT_MIGRATIONS.map(m=>m.version===10?{...m,up:async(db:Parameters<typeof m.up>[0])=>{await m.up(db);throw Error("synthetic bridge fault");}}:m);
  await expect(bootstrapBotDatabase(fixture.db,broken)).rejects.toThrow("synthetic bridge fault");
  expect(await columns()).toHaveLength(0);expect(await fixture.snapshot()).toEqual(before);
  expect(await bootstrapBotDatabase(fixture.db)).toEqual({applied:[10,11,12,13,14,15]});
 });
});
