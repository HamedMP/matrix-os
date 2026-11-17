import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { BotSchemaError, bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineActionOwnerRoutes } from "../../../packages/gateway/src/bots/routine-action-routes.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { hasLiveRoutineChat } from "../../../packages/gateway/src/bots/routine-authorization.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { startBots } from "../../../packages/gateway/src/startup/bots.js";
import { NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

import { retainRoutinePreviewSchema } from "./fixtures/retained-routine-preview-schema.js";

const retainedBotId = `bot_routine${"a".repeat(32)}`;
const retainedChatId = `chat_routine_${"b".repeat(32)}`;
const retainedRoutineId = `rt_${"c".repeat(24)}`;
const legacyMigrations = BOT_MIGRATIONS.slice(0, 15);
const principal = { userId: OWNER, source: "jwt" as const };
const ledger = (db: Kysely<OwnerBotDatabase>) => db.selectFrom("bot_schema_migrations").selectAll().orderBy("version").execute();

async function createHistoricalRoutine(db: Kysely<OwnerBotDatabase>, status: "archived" | "paused", fireStatus: "uncertain" | "dispatched") {
  const sourceChatId = "chat_original_source";
  await insertChat(db, retainedChatId);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: retainedBotId, chatId: retainedChatId, now: NOW });
  await sql`INSERT INTO routine_direct_chat_contexts VALUES (${OWNER},'computer-one',${sourceChatId},${retainedBotId},${retainedChatId},${NOW})`.execute(db);
  await db.insertInto("bot_routines").values({
    routine_id: retainedRoutineId, owner_id: OWNER, bot_id: retainedBotId, chat_id: retainedChatId,
    status, proposal: { name: "Historical preview" }, approved_source: null, approval_id: null,
    next_fire_at: null, created_at: NOW, updated_at: NOW,
  }).execute();
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: retainedBotId, chatId: retainedChatId, now: NOW });
  await db.updateTable("bot_tasks").set({ status: "failed" }).where("task_id", "=", task.taskId).execute();
  await db.insertInto("bot_routine_fires").values({
    fire_id: `fire_${"d".repeat(24)}`, owner_id: OWNER, routine_id: retainedRoutineId, task_id: task.taskId,
    scheduled_for: NOW, status: fireStatus, retry_after: null, lease_expires_at: null, failure_code: null, created_at: NOW, updated_at: NOW,
  }).execute();
  return task;
}

it("restores Bot startup and its owner routine-action route with dormant retained preview history", async () => {
  const { db, destroy } = await createBotStateDatabase({ migrate: false });
  const home = await mkdtemp(join(tmpdir(), "matrix-retained-routine-preview-"));
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  let services: Awaited<ReturnType<typeof startBots>>;
  try {
    await bootstrapBotDatabase(db, legacyMigrations);
    await retainRoutinePreviewSchema(db);
    await createHistoricalRoutine(db, "archived", "uncertain");
    await agents.bootstrap();
    const before = await ledger(db);
    await expect(bootstrapBotDatabase(db, legacyMigrations)).resolves.toEqual({ applied: [] });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
    services = await startBots({
      homePath: home, repository, agents, runtimeOwnerId: OWNER, configuredOwnerIds: [OWNER], computerId: "computer-one",
      routineActionPlatform: { platformUrl: "https://platform.example.test", handle: "computer-one", machineId: "fixture-machine", runtimeSlot: "dev", token: "fixture" },
      host: { available: true, client: {}, registerAuthorizer: vi.fn(() => vi.fn()), close: vi.fn() } as never,
      executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    });
    const app = new Hono().route("/", createRoutineActionOwnerRoutes({ actions: services?.routineCli ?? null, getPrincipal: () => principal }));
    const response = await app.request("/api/routine-cli/actions");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenges: [] });
    expect(await ledger(db)).toEqual(before);
    expect(await db.selectFrom("bot_routine_fires").select("status").execute()).toEqual([{ status: "uncertain" }]);
    expect(await hasLiveRoutineChat(db, OWNER, retainedBotId, retainedChatId)).toBe(false);
  } finally {
    await services?.close();
    await agents.close();
    await destroy();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["future version", "wrong shape", "partial ledger", "wrong index", "paused routine", "unsettled fire", "blocked coordinator task", "pending decision"] as const)("rejects incompatible retained preview state: %s", async fault => {
  const { db, destroy } = await createBotStateDatabase({ migrate: false });
  try {
    await bootstrapBotDatabase(db, legacyMigrations);
    await retainRoutinePreviewSchema(db);
    if (fault === "future version") await db.insertInto("bot_schema_migrations").values({ version: 19, name: "unknown_future" }).execute();
    if (fault === "wrong shape") await sql`ALTER TABLE bot_routines ALTER COLUMN origin_computer_id SET DEFAULT 'unverified'`.execute(db);
    if (fault === "partial ledger") await db.deleteFrom("bot_schema_migrations").where("version", "=", 17).execute();
    if (fault === "wrong index") {
      await sql`DROP INDEX idx_bot_chat_bindings_chat_history`.execute(db);
      await sql`CREATE INDEX idx_bot_chat_bindings_chat_history ON bot_chat_bindings (owner_id, chat_id, bot_id)`.execute(db);
    }
    if (fault === "paused routine") await createHistoricalRoutine(db, "paused", "uncertain");
    if (fault === "unsettled fire") await createHistoricalRoutine(db, "archived", "dispatched");
    if (fault === "blocked coordinator task") {
      await createHistoricalRoutine(db, "archived", "uncertain");
      const tasks = createBotTasksRepository(db);
      const task = await tasks.create({ ownerId: OWNER, botId: retainedBotId, chatId: retainedChatId, now: NOW });
      await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision,
        to: "blocked", blockedReason: "capacity_unavailable", now: NOW });
    }
    if (fault === "pending decision") {
      const task = await createHistoricalRoutine(db, "archived", "uncertain");
      await createBotInteractionsRepository(db).create({
        ownerId: OWNER, botId: retainedBotId, chatId: retainedChatId, taskId: task.taskId, kind: "approval",
        payload: { kind: "approval", tool: "routine.activate", argsDigest: "e".repeat(64), audience: "direct", policyRevision: 1, preview: "{}" },
        responderActorId: OWNER, blocking: true, expiresAt: "2026-09-27T13:00:00.000Z", now: NOW,
      });
    }
    const before = await ledger(db);
    await expect(bootstrapBotDatabase(db, legacyMigrations)).rejects.toEqual(new BotSchemaError("newer_schema"));
    await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError(fault === "partial ledger" ? "invalid_migrations" : "newer_schema"));
    expect(await ledger(db)).toEqual(before);
  } finally {
    await destroy();
  }
});
