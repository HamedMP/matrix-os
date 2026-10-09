import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { bootstrapChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { BOT, OWNER } from "./bot-state-support.js";
import { migrateDeployedProviderConnectionsV5 } from "./fixtures/provider-schema-v5.js";
import { migrateDeployedChatGptPlanDevicesV6 } from "./fixtures/provider-schema-v6.js";

const deployedV5 = [...BOT_MIGRATIONS.slice(0,4), {version:5,name:"bot_provider_connections",up:migrateDeployedProviderConnectionsV5}];
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("released v6 pooled startup compatibility", () => {
  let db: Kysely<OwnerBotDatabase>, admin: Kysely<Record<string,never>>, schema: string;
  beforeEach(async () => {
    const connectionString=process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.toLowerCase().includes("test")) throw new Error("Dedicated test database required");
    schema=`bots_v6_${randomUUID().replaceAll("-","")}`;
    admin=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({connectionString,max:1})})});
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db=new Kysely({dialect:new PostgresDialect({pool:new pg.Pool({connectionString,max:8,options:`-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`})})});
    await bootstrapChatDatabase(db);
    await bootstrapBotDatabase(db,deployedV5);
  });
  afterEach(async () => { await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); });
  const pins = () => db.selectFrom("bot_chatgpt_plan_devices").selectAll().orderBy("owner_id").orderBy("computer_id").execute();
  const concurrentStarts = () => Promise.all(Array.from({length:12},()=>bootstrapBotDatabase(db)));

  it("applies v6 exactly once across twelve pooled startups and leaves v5 authorization and execution bindings intact",async () => {
    await sql`INSERT INTO bot_provider_authorizations VALUES (${OWNER}, 'computer_saved', 'claude_code_tasks', 'saved-fingerprint', true, true, 7)`.execute(db);
    await sql`INSERT INTO bot_execution_bindings VALUES (${OWNER}, 'computer_saved', ${BOT}, 'claude_code_tasks', 'sonnet', 7, 'native_saved', 4)`.execute(db);
    const authorizations=await sql`SELECT * FROM bot_provider_authorizations`.execute(db);
    const bindings=await sql`SELECT * FROM bot_execution_bindings`.execute(db);
    const starts=await concurrentStarts();
    expect(starts.flatMap(result=>result.applied)).toEqual([6]);
    expect(await db.selectFrom("bot_schema_migrations").select(["version","name"]).where("version","=",6).execute()).toEqual([{version:6,name:"bot_chatgpt_plan_devices"}]);
    expect(await pins()).toEqual([]);
    expect((await sql`SELECT * FROM bot_provider_authorizations`.execute(db)).rows).toEqual(authorizations.rows);
    expect((await sql`SELECT * FROM bot_execution_bindings`.execute(db)).rows).toEqual(bindings.rows);
  });

  it("never modifies owner/computer identity pins during concurrent restart of the frozen deployed v6",async () => {
    await db.transaction().execute(async trx => {
      await migrateDeployedChatGptPlanDevicesV6(trx);
      await trx.insertInto("bot_schema_migrations").values({version:6,name:"bot_chatgpt_plan_devices"}).execute();
    });
    const saved=[{owner_id:OWNER,computer_id:"computer_saved",device_id:"a".repeat(64),public_key:"fixture-public-key-a".repeat(3)},
      {owner_id:OWNER,computer_id:"computer_other",device_id:"b".repeat(64),public_key:"fixture-public-key-b".repeat(3)},
      {owner_id:"other_owner",computer_id:"computer_saved",device_id:"c".repeat(64),public_key:"fixture-public-key-c".repeat(3)}];
    await db.insertInto("bot_chatgpt_plan_devices").values(saved).execute();
    const before=await pins();
    expect((await concurrentStarts()).every(result=>result.applied.length===0)).toBe(true);
    expect(await pins()).toEqual(before);
  });
});
