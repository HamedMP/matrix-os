/** Frozen deployed schema to additive routines: real pooled PostgreSQL only. */
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { BotSchemaError, bootstrapBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { OWNER, NOW, V9_DIRECT, createDeployedV9Fixture, v9PgEnabled, type DeployedV9Fixture } from "./deployed-v9-postgres-support.js";

describe.skipIf(!v9PgEnabled)("released v9 and unpublished routine migration identities", () => {
  let fixture: DeployedV9Fixture | undefined;
  afterEach(async () => { await fixture?.destroy(); fixture = undefined; });
  const routineTables = async () => (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables
    WHERE table_schema=current_schema() AND table_name IN ('bot_routines','bot_routine_fires') ORDER BY table_name`.execute(fixture!.db)).rows;

  it("appends the v10 compatibility bridge and routines v11 to genuine v9 while preserving every retained row and timestamp", async () => {
    fixture = await createDeployedV9Fixture();
    const before = await fixture.snapshot();
    await expect(bootstrapBotDatabase(fixture.db)).resolves.toEqual({ applied: BOT_MIGRATIONS.slice(9).map(({ version }) => version) });
    expect(await fixture.snapshot()).toEqual(before);
    expect(await routineTables()).toEqual([{ table_name: "bot_routine_fires" }, { table_name: "bot_routines" }]);
    expect(await fixture.db.selectFrom("bot_schema_migrations").select(["version", "name"]).where("version", "=", 11).execute())
      .toEqual([{ version: 11, name: "bot_routines" }]);
    await expect(bootstrapBotDatabase(fixture.db)).resolves.toEqual({ applied: [] });
  });

  it("upgrades v8 direct/group bindings additively without editing their saved values or migration timestamps", async () => {
    fixture = await createDeployedV9Fixture(8);
    await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: "bot_group01234567", chat_id: V9_DIRECT,
      kind: "group", created_at: NOW, removed_at: null }).execute();
    const before = await fixture.snapshot();
    await expect(bootstrapBotDatabase(fixture.db)).resolves.toEqual({ applied: BOT_MIGRATIONS.slice(8).map(({ version }) => version) });
    const after = await fixture.snapshot();
    expect(after.rows).toEqual({ ...before.rows,
      bot_chat_bindings: before.rows.bot_chat_bindings!.map(row => Object.assign({}, row, { project_id: null })),
    });
    expect(after.history.filter(row => row.version <= 8)).toEqual(before.history);
    expect(await fixture.db.selectFrom("bot_schema_migrations").select(["version", "name"]).where("version", ">=", 9).where("version", "<=", 18).orderBy("version").execute())
      .toEqual([{ version: 9, name: "question_source_run" }, { version: 10, name: "bot_question_threads_bridge" }, { version: 11, name: "bot_routines" },
        { version: 12, name: "routine_cli_preferences" }, { version: 13, name: "routine_cli_sources" },
        { version: 14, name: "routine_cli_requests" }, { version: 15, name: "routine_cli_proposals" }, { version: 16, name: "routine_chat_origin" }, { version: 17, name: "routine_direct_chat" }, { version: 18, name: "bot_chat_binding_history_index" }]);
    expect(await routineTables()).toHaveLength(2);
  });

  it("upgrades v17 with a full chat-ordered binding index and preserves removed bindings", async () => {
    fixture = await createDeployedV9Fixture();
    const { db } = fixture;
    await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 17));
    await db.insertInto("bot_chat_bindings").values({
      owner_id: OWNER, bot_id: "bot_removed01234567", chat_id: V9_DIRECT,
      kind: "group", created_at: NOW, removed_at: NOW,
    }).execute();
    const before = await fixture.snapshot();
    const history = await db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
    const chatIndexes = async () => (await sql<{
      access_method: string; chat_key: string; owner_key: string; bot_key: string; includes_removed: boolean;
    }>`
      SELECT access_method.amname AS access_method,
        pg_get_indexdef(indexrelid, 1, false) AS chat_key,
        pg_get_indexdef(indexrelid, 2, false) AS owner_key,
        pg_get_indexdef(indexrelid, 3, false) AS bot_key,
        indpred IS NULL AS includes_removed
      FROM pg_index
      JOIN pg_class ON oid = indexrelid
      JOIN pg_am access_method ON access_method.oid = relam
      WHERE indrelid = 'bot_chat_bindings'::regclass AND pg_get_indexdef(indexrelid, 1, false) = 'chat_id'
    `.execute(db)).rows;

    expect(await chatIndexes()).toEqual([]);
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [18] });
    expect(await chatIndexes()).toEqual([{
      access_method: "btree", chat_key: "chat_id", owner_key: "owner_id", bot_key: "bot_id", includes_removed: true,
    }]);
    expect(await fixture.snapshot()).toEqual(before);
    expect(await db.selectFrom("bot_schema_migrations").selectAll().where("version", "<=", 17).orderBy("version").execute())
      .toEqual(history);
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
  });

  it.each([
    { base: 8 as const, version: 9, name: "bot_routines" },
    { base: 9 as const, version: 10, name: "unreviewed_other_feature" },
  ])("refuses colliding v$version/$name without relabeling history or executing pending DDL", async ({ base, version, name }) => {
    fixture = await createDeployedV9Fixture(base);
    await fixture.db.insertInto("bot_schema_migrations").values({ version, name }).execute();
    const before = await fixture.snapshot();
    const history = await fixture.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();
    await expect(bootstrapBotDatabase(fixture.db)).rejects.toEqual(new BotSchemaError("invalid_migrations"));
    expect(await fixture.snapshot()).toEqual(before);
    expect(await fixture.db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute()).toEqual(history);
    expect(await routineTables()).toEqual([]);
    const columns = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='bot_chat_bindings' AND column_name='project_id'`.execute(fixture.db);
    expect(columns.rows.length).toBe(base === 8 ? 0 : 1);
  });
});
