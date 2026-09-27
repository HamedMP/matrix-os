import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { BotSchemaError, bootstrapBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS, type BotMigration } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createBotStateDatabase } from "./bot-state-support.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function database(options?: { migrate?: boolean }) {
  const created = await createBotStateDatabase(options);
  cleanups.push(created.destroy);
  return created.db;
}

describe("bot state migrations", () => {
  it("creates every M1 table once and applies nothing on restart", async () => {
    const db = await database({ migrate: false });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [1] });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bot_%' ORDER BY table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "bot_agent_sessions", "bot_approvals", "bot_chat_bindings", "bot_connect_requests", "bot_grants",
      "bot_interactions", "bot_memory_items", "bot_operations", "bot_schema_migrations", "bot_tasks", "bot_tool_checkpoints",
    ]);
    const recorded = await db.selectFrom("bot_schema_migrations").select(["version", "name"]).execute();
    expect(recorded).toEqual([{ version: 1, name: "bot_state_m1" }]);
  });

  it("runs versions in order, one transaction each, so a failure keeps earlier versions", async () => {
    const db = await database({ migrate: false });
    const failing: BotMigration[] = [
      ...BOT_MIGRATIONS,
      {
        version: 2,
        name: "broken",
        up: async (trx) => {
          await sql`CREATE TABLE bot_half_applied (id INTEGER)`.execute(trx);
          throw new Error("boom");
        },
      },
    ];
    await expect(bootstrapBotDatabase(db, failing)).rejects.toThrow("boom");
    const versions = await db.selectFrom("bot_schema_migrations").select("version").execute();
    expect(versions).toEqual([{ version: 1 }]);
    const half = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'bot_half_applied'`.execute(db);
    expect(half.rows[0]!.n).toBe(0);
  });

  it("refuses misordered migration lists and a schema from a newer build", async () => {
    const db = await database({ migrate: false });
    await expect(bootstrapBotDatabase(db, [{ ...BOT_MIGRATIONS[0]!, version: 2 }])).rejects.toEqual(new BotSchemaError("invalid_migrations"));
    await bootstrapBotDatabase(db, [...BOT_MIGRATIONS, { version: 2, name: "future", up: async () => undefined }]);
    await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("newer_schema"));
  });
});
