import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { BotSchemaError, bootstrapBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS, type BotMigration } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

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
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [1, 2, 3, 4] });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bot_%' ORDER BY table_name
    `.execute(db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "bot_agent_sessions", "bot_approvals", "bot_chat_bindings", "bot_connect_requests", "bot_grants",
      "bot_interactions", "bot_memory_items", "bot_operations", "bot_schema_migrations", "bot_tasks", "bot_tool_checkpoints",
    ]);
    const recorded = await db.selectFrom("bot_schema_migrations").select(["version", "name"]).execute();
    expect(recorded).toEqual([{ version: 1, name: "bot_state_m1" }, { version: 2, name: "bot_approvals_by_task" }, { version: 3, name: "bot_connect_retry_schedule" }, { version: 4, name: "managed_pi_state" }]);
  });

  it("runs versions in order, one transaction each, so a failure keeps earlier versions", async () => {
    const db = await database({ migrate: false });
    const failing: BotMigration[] = [
      ...BOT_MIGRATIONS,
      {
        version: 5,
        name: "broken",
        up: async (trx) => {
          await sql`CREATE TABLE bot_half_applied (id INTEGER)`.execute(trx);
          throw new Error("boom");
        },
      },
    ];
    await expect(bootstrapBotDatabase(db, failing)).rejects.toThrow("boom");
    const versions = await db.selectFrom("bot_schema_migrations").select("version").execute();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    const half = await sql<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'bot_half_applied'`.execute(db);
    expect(half.rows[0]!.n).toBe(0);
  });

  it("refuses misordered migration lists and a schema from a newer build", async () => {
    const db = await database({ migrate: false });
    await expect(bootstrapBotDatabase(db, [{ ...BOT_MIGRATIONS[0]!, version: 2 }])).rejects.toEqual(new BotSchemaError("invalid_migrations"));
    await bootstrapBotDatabase(db, [...BOT_MIGRATIONS, { version: 5, name: "future", up: async () => undefined }]);
    await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError("newer_schema"));
  });

  it("moves approvals written under v1 onto their interaction's task", async () => {
    const db = await database({ migrate: false });
    await bootstrapBotDatabase(db, [BOT_MIGRATIONS[0]!]);
    await insertChat(db, "chat_migrate1");
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_migrate1", now: NOW });
    const { interaction } = await createBotInteractionsRepository(db).create({
      ownerId: OWNER, botId: BOT, chatId: "chat_migrate1", taskId: task.taskId, kind: "approval", payload: { kind: "approval" },
      responderActorId: OWNER, blocking: true, expiresAt: "2026-09-28T12:00:00.000Z", now: NOW,
    });
    await sql`
      INSERT INTO bot_approvals (approval_id, owner_id, bot_id, run_id, tool, args_hash, account, audience, policy_revision, status, expires_at, created_at, updated_at)
      VALUES (${interaction.interactionId}, ${OWNER}, ${BOT}, 'run_v1', 'integration.call', ${"a".repeat(64)}, 'gmail:work', 'direct', 1, 'pending', '2026-09-28T12:00:00Z', ${NOW}, ${NOW})
    `.execute(db);
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [2, 3, 4] });
    const [row] = await db.selectFrom("bot_approvals").select(["task_id", "run_id"]).execute();
    expect(row).toEqual({ task_id: task.taskId, run_id: "run_v1" });
  });
});
