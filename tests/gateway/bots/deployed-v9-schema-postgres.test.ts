/** Real PG only; intentionally exposes the unintegrated routine-v9 collision. NOT RUN during preparation. */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { BotSchemaError, bootstrapBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { DEPLOYED_THREADS_V9_SQL } from "./fixtures/provider-schema-v9.js";
import { createDeployedV9Fixture, v9PgEnabled, type DeployedV9Fixture } from "./deployed-v9-postgres-support.js";

describe.skipIf(!v9PgEnabled)("historical deployed v9 pooled compatibility", () => {
  let fixture: DeployedV9Fixture | undefined;
  beforeEach(async () => { fixture = await createDeployedV9Fixture(); });
  afterEach(async () => { await fixture?.destroy(); fixture = undefined; });

  it("opens the historical v9 without rewriting its threads, history, pins, authorizations or grants", async () => {
    const before = await fixture!.snapshot();
    const result = await bootstrapBotDatabase(fixture!.db);
    expect(result.applied).not.toContain(9);
    expect(await fixture!.snapshot()).toEqual(before);
    expect(await fixture!.db.selectFrom("bot_schema_migrations").select(["version", "name"]).where("version", "=", 9).execute())
      .toEqual([{ version: 9, name: "bot_chat_threads" }]);
  });

  it("repeated startup applies nothing after compatibility and keeps original applied_at records", async () => {
    const before = await fixture!.snapshot();
    await bootstrapBotDatabase(fixture!.db);
    await expect(bootstrapBotDatabase(fixture!.db)).resolves.toEqual({ applied: [] });
    await expect(bootstrapBotDatabase(fixture!.db)).resolves.toEqual({ applied: [] });
    expect(await fixture!.snapshot()).toEqual(before);
  });

  it("twelve pooled startup contenders retain frozen v9 and apply each additional version at most once", async () => {
    const before = await fixture!.snapshot();
    const settled = await Promise.allSettled(Array.from({ length: 12 }, () => bootstrapBotDatabase(fixture!.db)));
    expect(settled.every(result => result.status === "fulfilled")).toBe(true);
    const applied = settled.flatMap(result => result.status === "fulfilled" ? result.value.applied : []);
    expect(applied).not.toContain(9);
    expect(new Set(applied).size).toBe(applied.length);
    expect(await fixture!.snapshot()).toEqual(before);
    await expect(bootstrapBotDatabase(fixture!.db)).resolves.toEqual({ applied: [] });
  });

  it("rejects an unknown future on top of genuine v9 before creating routine tables or editing retained rows", async () => {
    const future = Math.max(9, ...BOT_MIGRATIONS.map(migration => migration.version)) + 1;
    await fixture!.db.insertInto("bot_schema_migrations").values({ version: future, name: "unreviewed_future" }).execute();
    const before = await fixture!.snapshot();
    const records = await fixture!.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
    await expect(bootstrapBotDatabase(fixture!.db)).rejects.toEqual(new BotSchemaError("newer_schema"));
    expect(await fixture!.snapshot()).toEqual(before);
    expect(await fixture!.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute()).toEqual(records);
    const tables = await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('bot_routines', 'bot_routine_fires')`.execute(fixture!.db);
    expect(tables.rows).toEqual([]);
  });
});

describe.skipIf(!v9PgEnabled)("v8 to frozen v9 contract", () => {
  let fixture: DeployedV9Fixture | undefined;
  beforeEach(async () => { fixture = await createDeployedV9Fixture(8); });
  afterEach(async () => { await fixture?.destroy(); fixture = undefined; });

  it("emits the five historical v9 SQL statements and records both canonical question and bridge identities exactly once", async () => {
    const statements: string[] = [];
    const traced = fixture!.db.withPlugin({
      transformQuery({ node, queryId }) {
        const query = fixture!.db.getExecutor().compileQuery(node, queryId);
        if (/^\s*(ALTER TABLE bot_chat_bindings|CREATE INDEX idx_bot_chat_bindings_threads)/.test(query.sql)) statements.push(query.sql);
        return node;
      },
      async transformResult({ result }) { return result; },
    });
    await bootstrapBotDatabase(traced);
    expect(statements).toEqual([...DEPLOYED_THREADS_V9_SQL]);
    expect(await fixture!.db.selectFrom("bot_schema_migrations").select(["version", "name"]).where("version", ">=", 9).where("version", "<=", 10).orderBy("version").execute())
      .toEqual([{ version: 9, name: "question_source_run" }, { version: 10, name: "bot_question_threads_bridge" }]);
    await expect(bootstrapBotDatabase(fixture!.db)).resolves.toEqual({ applied: [] });
  });

  it("still rejects a colliding v9 name without relabeling it or applying pending DDL", async () => {
    await fixture!.db.insertInto("bot_schema_migrations").values({ version: 9, name: "wrong_v9_identity" }).execute();
    const before = await fixture!.snapshot();
    await expect(bootstrapBotDatabase(fixture!.db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
    expect(await fixture!.snapshot()).toEqual(before);
    const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='bot_chat_bindings' AND column_name='project_id'`.execute(fixture!.db);
    expect(columns.rows).toEqual([]);
  });
});
