import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_direct1");
  await insertChat(db, "chat_direct2");
});
afterEach(async () => destroy());

describe("bot chat bindings repository", () => {
  it("keeps one live direct chat per bot and binds idempotently", async () => {
    const repo = createBotBindingsRepository(db);
    const bound = await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    expect(bound).toMatchObject({ kind: "direct", removedAt: null });
    await expect(repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: at(1) })).resolves.toEqual(bound);
    await expect(repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct2", now: NOW }))
      .rejects.toEqual(new BotStateError("conflict"));
    await expect(repo.directChatId({ ownerId: OWNER, botId: BOT })).resolves.toBe("chat_direct1");
    await expect(repo.forChat({ ownerId: OWNER, chatId: "chat_direct1" })).resolves.toHaveLength(1);
  });

  it("removes a binding once and then allows a new direct chat", async () => {
    const repo = createBotBindingsRepository(db);
    await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await expect(repo.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: at(1) })).resolves.toBe(true);
    await expect(repo.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: at(2) })).resolves.toBe(false);
    await expect(repo.directChatId({ ownerId: OWNER, botId: BOT })).resolves.toBeUndefined();
    await expect(repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct2", now: at(3) })).resolves.toMatchObject({ chatId: "chat_direct2" });
  });

  it("drops bindings with their chat", async () => {
    const repo = createBotBindingsRepository(db);
    await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await db.deleteFrom("chats").where("id", "=", "chat_direct1").execute();
    await expect(repo.directChatId({ ownerId: OWNER, botId: BOT })).resolves.toBeUndefined();
  });

  it("restores a removed binding to the same chat and refuses a chat the owner does not own", async () => {
    const repo = createBotBindingsRepository(db);
    await repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
    await repo.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: at(1) });
    await expect(repo.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: at(2) }))
      .resolves.toMatchObject({ chatId: "chat_direct1", removedAt: null, createdAt: at(2) });
    await insertChat(db, "chat_foreign1", OTHER_OWNER);
    await expect(repo.bindDirect({ ownerId: OWNER, botId: "bot_fedcba9876543210", chatId: "chat_foreign1", now: NOW }))
      .rejects.toEqual(new BotStateError("not_found"));
  });
});
