import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const PROJECT = "proj_brain01";
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

afterEach(async () => destroy());

describe("bot chat threads migration", () => {
  beforeEach(async () => { ({ db, destroy } = await createBotStateDatabase({ migrate: false })); });

  it("applies v7 on a v6 database and keeps existing bindings without a project", async () => {
    await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 6));
    await insertChat(db, "chat_direct1");
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [7] });
    await expect(createBotBindingsRepository(db).forChat({ ownerId: OWNER, chatId: "chat_direct1" }))
      .resolves.toEqual([expect.objectContaining({ kind: "direct", projectId: null })]);
  });

  it("requires a proj_ project on threads and refuses one on direct and group bindings", async () => {
    await bootstrapBotDatabase(db);
    await insertChat(db, "chat_check1");
    const insert = (kind: string, projectId: string | null) => sql`
      INSERT INTO bot_chat_bindings (owner_id, bot_id, chat_id, kind, project_id, created_at)
      VALUES (${OWNER}, ${BOT}, 'chat_check1', ${kind}, ${projectId}, ${NOW})`.execute(db);
    await expect(insert("thread", null)).rejects.toThrow();
    await expect(insert("thread", "matrix-os")).rejects.toThrow();
    await expect(insert("direct", PROJECT)).rejects.toThrow();
    await expect(insert("group", PROJECT)).rejects.toThrow();
    await expect(insert("other", null)).rejects.toThrow();
    await expect(insert("thread", PROJECT)).resolves.toBeDefined();
  });
});

describe("bot thread bindings", () => {
  beforeEach(async () => {
    ({ db, destroy } = await createBotStateDatabase());
    for (const chatId of ["chat_direct1", "chat_thread1", "chat_thread2", "chat_thread3"]) await insertChat(db, chatId);
  });

  it("binds a thread once with its project and refuses any other binding of that Chat", async () => {
    const repo = createBotBindingsRepository(db);
    const thread = await repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", projectId: PROJECT, now: NOW });
    expect(thread).toMatchObject({ kind: "thread", projectId: PROJECT, removedAt: null });
    await expect(repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", projectId: PROJECT, now: at(1) })).resolves.toEqual(thread);
    await expect(repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", projectId: "proj_other", now: at(1) }))
      .rejects.toEqual(new BotStateError("conflict"));
    await expect(repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", now: at(2) })).rejects.toEqual(new BotStateError("conflict"));
    await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await expect(repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", projectId: PROJECT, now: at(3) }))
      .rejects.toEqual(new BotStateError("conflict"));
    await expect(repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread2", projectId: "matrix-os", now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_input"));
    await insertChat(db, "chat_foreign1", OTHER_OWNER);
    await expect(repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_foreign1", projectId: PROJECT, now: NOW }))
      .rejects.toEqual(new BotStateError("not_found"));
    await expect(repo.directChatId({ ownerId: OWNER, botId: BOT })).resolves.toBe("chat_direct1");
  });

  it("finds the bot of a direct Chat or a live thread, never a removed or group one", async () => {
    const repo = createBotBindingsRepository(db);
    await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", projectId: PROJECT, now: NOW });
    await expect(repo.boundBot({ ownerId: OWNER, chatId: "chat_direct1" })).resolves.toEqual({ botId: BOT, kind: "direct", projectId: null });
    await expect(repo.boundBot({ ownerId: OWNER, chatId: "chat_thread1" })).resolves.toEqual({ botId: BOT, kind: "thread", projectId: PROJECT });
    await expect(repo.boundBot({ ownerId: OTHER_OWNER, chatId: "chat_thread1" })).resolves.toBeNull();
    await sql`INSERT INTO bot_chat_bindings (owner_id, bot_id, chat_id, kind, created_at) VALUES (${OWNER}, ${BOT}, 'chat_thread2', 'group', ${NOW})`.execute(db);
    await expect(repo.boundBot({ ownerId: OWNER, chatId: "chat_thread2" })).resolves.toBeNull();
    await repo.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_thread1", now: at(1) });
    await expect(repo.boundBot({ ownerId: OWNER, chatId: "chat_thread1" })).resolves.toBeNull();
    await expect(sql`UPDATE bot_chat_bindings SET kind = 'direct' WHERE chat_id = 'chat_thread1'`.execute(db)).rejects.toThrow();
  });

  it("pages one project's live, active threads by newest Chat activity and counts live threads", async () => {
    const repo = createBotBindingsRepository(db);
    for (const [index, chatId] of ["chat_thread1", "chat_thread2", "chat_thread3"].entries()) {
      await repo.bindThread({ ownerId: OWNER, botId: BOT, chatId, projectId: PROJECT, now: NOW });
      await db.updateTable("chats").set({ activity_at: at(index * 1_000) }).where("id", "=", chatId).execute();
    }
    await insertChat(db, "chat_otherproj");
    await repo.bindThread({ ownerId: OWNER, botId: BOT, chatId: "chat_otherproj", projectId: "proj_other", now: NOW });
    const first = await repo.threadPage({ ownerId: OWNER, botId: BOT, projectId: PROJECT, limit: 2 });
    expect(first.chatIds).toEqual(["chat_thread3", "chat_thread2"]);
    const second = await repo.threadPage({ ownerId: OWNER, botId: BOT, projectId: PROJECT, limit: 2, cursor: first.next! });
    expect(second).toEqual({ chatIds: ["chat_thread1"] });
    await db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", "chat_thread2").execute();
    await repo.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_thread3", now: at(5) });
    expect((await repo.threadPage({ ownerId: OWNER, botId: BOT, projectId: PROJECT, limit: 50 })).chatIds).toEqual(["chat_thread1"]);
    await expect(repo.liveThreadCount({ ownerId: OWNER, botId: BOT })).resolves.toBe(3);
    await db.deleteFrom("chats").where("id", "=", "chat_thread1").execute();
    await expect(repo.liveThreadCount({ ownerId: OWNER, botId: BOT })).resolves.toBe(2);
    await expect(repo.threadPage({ ownerId: OTHER_OWNER, botId: BOT, projectId: PROJECT, limit: 50 })).resolves.toEqual({ chatIds: [] });
  });
});
