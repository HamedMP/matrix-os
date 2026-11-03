/** Released migration identities and SQL are a compatibility contract, not implementation detail. */
import { describe, expect, it } from "vitest";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { migrateBotChatThreadsV9 } from "../../../packages/gateway/src/bots/thread-migration.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { DEPLOYED_THREADS_V9_SQL } from "./fixtures/provider-schema-v9.js";

describe("released thread and unpublished routine registry compatibility", () => {
  it("reserves the recorded deployed v9 identity and places unpublished routines after it", () => {
    expect(BOT_MIGRATIONS.map(({ version, name }) => ({ version, name })).slice(8)).toEqual([
      { version: 9, name: "question_source_run" }, { version: 10, name: "bot_question_threads_bridge" }, { version: 11, name: "bot_routines" },
    ]);
  });

  it("emits the exact independent frozen deployed v9 SQL without an external database", async () => {
    const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const db = new Kysely<OwnerBotDatabase>({ dialect: {
      createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
      createIntrospector: db => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler(),
    }, plugins: [{ transformQuery({ node, queryId }) {
      if (statements.length >= 16) throw new Error("SQL capture cap");
      const query = db.getExecutor().compileQuery(node, queryId);
      statements.push({ sql: query.sql, parameters: query.parameters }); return node;
    }, async transformResult({ result }) { return result; } }] });
    try {
      await db.transaction().execute(migrateBotChatThreadsV9);
      expect(statements).toEqual(DEPLOYED_THREADS_V9_SQL.map(sql => ({ sql, parameters: [] })));
    } finally { await db.destroy(); }
  });
});
