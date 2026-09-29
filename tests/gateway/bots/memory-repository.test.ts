import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { MAX_MEMORY_ITEMS_PER_BOT, createBotMemoryRepository } from "../../../packages/gateway/src/bots/repositories/memory.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const base = { ownerId: OWNER, botId: BOT, kind: "fact" as const, scope: "bot", source: { at: NOW }, confirmed: true };

beforeEach(async () => ({ db, destroy } = await createBotStateDatabase()));
afterEach(async () => destroy());

describe("bot memory repository", () => {
  it("ranks confirmed matches and never returns unconfirmed or foreign items", async () => {
    const repo = createBotMemoryRepository(db);
    await repo.remember({ ...base, content: "Acme prefers weekly briefs on Monday", now: NOW });
    await repo.remember({ ...base, content: "Acme Acme Acme is the priority account for briefs", now: at(1) });
    await repo.remember({ ...base, content: "Acme pricing page says enterprise tier", confirmed: false, now: at(2) });
    await repo.remember({ ...base, content: "Acme weekly note in another chat", scope: "chat:chat_other1", now: at(3) });
    await repo.remember({ ...base, ownerId: OTHER_OWNER, content: "Acme secret of another owner", now: at(4) });

    const hits = await repo.search({ ownerId: OWNER, botId: BOT, query: "acme", scopes: ["bot"], limit: 10, now: at(5) });
    expect(hits.map((item) => item.content)).toEqual([
      "Acme Acme Acme is the priority account for briefs",
      "Acme prefers weekly briefs on Monday",
    ]);
    const scoped = await repo.search({ ownerId: OWNER, botId: BOT, query: "weekly", scopes: ["bot", "chat:chat_other1"], now: at(5) });
    expect(scoped).toHaveLength(2);
    await expect(repo.search({ ownerId: OWNER, botId: BOT, query: "   ", scopes: ["bot"], now: at(5) })).resolves.toEqual([]);
  });

  it("admits an unconfirmed item into search only after the owner confirms it", async () => {
    const repo = createBotMemoryRepository(db);
    const item = await repo.remember({ ...base, content: "Globex renews in March", confirmed: false, now: NOW });
    await expect(repo.search({ ownerId: OWNER, botId: BOT, query: "globex", scopes: ["bot"], now: at(1) })).resolves.toEqual([]);
    await expect(repo.list({ ownerId: OWNER, botId: BOT, now: at(1) })).resolves.toEqual([expect.objectContaining({ confirmed: false })]);
    await repo.confirm({ ownerId: OWNER, itemId: item.itemId, baseRevision: 1, now: at(2) });
    await expect(repo.search({ ownerId: OWNER, botId: BOT, query: "globex", scopes: ["bot"], now: at(3) })).resolves.toHaveLength(1);
    await expect(repo.confirm({ ownerId: OWNER, itemId: item.itemId, baseRevision: 1, now: at(4) })).rejects.toEqual(new BotStateError("revision_conflict"));
  });

  it("forgets an item and flags the bot's transcripts for recompaction together", async () => {
    await insertChat(db, "chat_mem1");
    const sessions = createBotSessionsRepository(db);
    await sessions.save({ ownerId: OWNER, botId: BOT, chatId: "chat_mem1", baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: {}, now: NOW });
    const repo = createBotMemoryRepository(db);
    const item = await repo.remember({ ...base, content: "The person is allergic to peanuts", kind: "preference", now: NOW });
    await expect(repo.forget({ ownerId: OTHER_OWNER, itemId: item.itemId, baseRevision: item.revision, now: at(1) })).resolves.toBe(false);
    // A stale revision forgets nothing.
    await expect(repo.forget({ ownerId: OWNER, itemId: item.itemId, baseRevision: item.revision + 1, now: at(1) })).resolves.toBe(false);
    await expect(repo.forget({ ownerId: OWNER, itemId: item.itemId, baseRevision: item.revision, now: at(1) })).resolves.toBe(true);
    await expect(repo.forget({ ownerId: OWNER, itemId: item.itemId, baseRevision: item.revision + 1, now: at(2) })).resolves.toBe(false);
    await expect(repo.search({ ownerId: OWNER, botId: BOT, query: "peanuts", scopes: ["bot"], now: at(3) })).resolves.toEqual([]);
    await expect(sessions.load({ ownerId: OWNER, botId: BOT, chatId: "chat_mem1" })).resolves.toMatchObject({ needsRecompaction: true });
  });

  it("enforces the per-bot cap inside the insert transaction", async () => {
    const repo = createBotMemoryRepository(db);
    await seedMemory(db, MAX_MEMORY_ITEMS_PER_BOT - 1);
    await expect(repo.remember({ ...base, content: "the last one that fits", now: at(1) })).resolves.toMatchObject({ confirmed: true });
    await expect(repo.remember({ ...base, content: "one too many", now: at(2) })).rejects.toEqual(new BotStateError("capacity_exceeded"));
    // Forgotten items free their slots.
    const first = (await repo.list({ ownerId: OWNER, botId: BOT, limit: 1, now: at(3) }))[0]!;
    await repo.forget({ ownerId: OWNER, itemId: first.itemId, baseRevision: first.revision, now: at(4) });
    await expect(repo.remember({ ...base, content: "fits again", now: at(5) })).resolves.toMatchObject({ content: "fits again" });
    await expect(repo.remember({ ...base, content: "x".repeat(5_000), now: NOW })).rejects.toEqual(new BotStateError("too_large"));
  }, 60_000);
});

async function seedMemory(target: Kysely<OwnerBotDatabase>, count: number): Promise<void> {
  await target.insertInto("bot_memory_items").values(Array.from({ length: count }, (_, index) => ({
    item_id: `mem_seed${String(index).padStart(6, "0")}`, owner_id: OWNER, bot_id: BOT, kind: "episode" as const, scope: "bot",
    content: `episode ${index}`, source: JSON.stringify({ at: NOW }), confirmed: true, created_at: NOW, updated_at: NOW,
    expires_at: null, forgotten_at: null,
  }))).execute();
}

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("bot memory repository on pooled Postgres", () => {
  it("admits exactly one of several concurrent inserts into the last free slot", async () => {
    const real = await createRealBotStateDatabase();
    try {
      await seedMemory(real.db, MAX_MEMORY_ITEMS_PER_BOT - 1);
      const repo = createBotMemoryRepository(real.db);
      const results = await Promise.allSettled([1, 2, 3, 4].map((n) => repo.remember({ ...base, content: `racing ${n}`, now: at(n) })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    } finally {
      await real.destroy();
    }
  }, 60_000);
});
