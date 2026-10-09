import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrainResolvedProject } from "../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixChatHandler, type BrainMatrixChatReader,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import { createBotBindingsRepository, createBotChatIdsLookup } from "../../packages/gateway/src/bots/repositories/bindings.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop } from "./helpers/brain-source-matrix-loop.js";
import { BOT, NOW, OTHER_OWNER, OWNER, createBotStateDatabase, insertChat } from "./bots/bot-state-support.js";

const project: BrainResolvedProject = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
const day = "2026-10-01T08:00:00.000Z";
const titles: Record<string, string> = { chat_plain: "Roadmap", chat_brain: "Why did the sidebar change" };

const reader: BrainMatrixChatReader = {
  get: async (who, chatId) => (who.ownerId === "owner_a" && titles[chatId] !== undefined
    ? { chat: { id: chatId, title: titles[chatId]!, updatedAt: day } } : null),
  getMessages: async (_who, _chatId, { afterSeq }) => (afterSeq > 0 ? [] : [
    { seq: 1, role: "assistant", state: "committed", parts: [{ type: "text", text: "An answer" }], createdAt: day },
  ]),
  list: async () => ({
    items: Object.entries(titles).map(([id, title]) => ({ chat: { id, title, activityAt: day, updatedAt: day } })),
    nextCursor: { activityAt: day, chatId: "chat_plain" },
  }),
};

describe("Bot chats in the matrix_chat brain source", () => {
  let harness: BrainHarness;
  let bots: Set<string>;
  const botChats = async (_ownerId: string, chatIds: readonly string[]) => new Set(chatIds.filter((id) => bots.has(id)));

  beforeEach(async () => {
    bots = new Set(["chat_brain"]);
    harness = await createBrainHarness();
    await bootstrapBrainMatrixDatabase(harness.db);
  });
  afterEach(async () => harness.destroy());

  async function sync(chatIds: string[]) {
    const handler = createBrainMatrixChatHandler({ kysely: harness.db, chats: reader, botChats, now: harness.now });
    const config = handler.parseConfig({ chatIds });
    const { externalRef } = handler.identify(project, config);
    const sourceId = await createMatrixSource(harness, "matrix_chat", externalRef);
    const resolution = await handler.createAdapter("owner_a", project, config);
    if (!resolution.ok) throw new Error("adapter");
    const run = () => runMatrixLoop(harness, sourceId, externalRef, resolution.adapter, config);
    return { handler, sourceId, run };
  }

  it("never offers a brain thread or the Bot's direct chat in the picker, and keeps the page cursor", async () => {
    const { handler } = await sync(["chat_plain"]);
    const options = await handler.listOptions!("owner_a", project, {}, new AbortController().signal);
    expect(options.items.map((item) => item.id)).toEqual(["chat_plain"]);
    expect(options.nextCursor).not.toBeNull();
  });

  it("never reads an opted-in brain chat", async () => {
    const { sourceId, run } = await sync(["chat_brain", "chat_plain"]);
    expect(await run()).toMatchObject({ caughtUp: true, written: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual(["Roadmap - 2026-10-01"]);
  });

  it("sweeps the documents of an opted-in chat once it becomes a Bot chat", async () => {
    bots.clear();
    const { sourceId, run } = await sync(["chat_brain", "chat_plain"]);
    expect(await run()).toMatchObject({ caughtUp: true, written: 2 });
    bots.add("chat_brain");
    expect(await run()).toMatchObject({ caughtUp: true, deleted: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual(["Roadmap - 2026-10-01"]);
  });
});

describe("the Bot chat lookup", () => {
  it("names the owner's chats with a live direct or thread binding, and no other chat", async () => {
    const { db, destroy } = await createBotStateDatabase();
    try {
      const bindings = createBotBindingsRepository(db);
      for (const id of ["chat_plain", "chat_direct", "chat_thread", "chat_gone"]) await insertChat(db, id);
      await insertChat(db, "chat_foreign", OTHER_OWNER);
      await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct", now: NOW });
      for (const chatId of ["chat_thread", "chat_gone"]) {
        await bindings.bindThread({ ownerId: OWNER, botId: BOT, chatId, projectId: "proj_brain01", now: NOW });
      }
      await bindings.remove({ ownerId: OWNER, botId: BOT, chatId: "chat_gone", now: NOW });
      await bindings.bindDirect({ ownerId: OTHER_OWNER, botId: BOT, chatId: "chat_foreign", now: NOW });
      const lookup = createBotChatIdsLookup(db);
      const asked = ["chat_plain", "chat_direct", "chat_thread", "chat_gone", "chat_foreign"];
      expect([...await lookup(OWNER, asked)].sort()).toEqual(["chat_direct", "chat_thread"]);
      expect((await lookup(OWNER, [])).size).toBe(0);
      await expect(lookup(OWNER, Array.from({ length: 201 }, (_, index) => `chat_many${index}`))).rejects.toThrow(RangeError);
    } finally {
      await destroy();
    }
  });

  it("reads no Bot chats before the Bot tables exist", async () => {
    const { db, destroy } = await createBotStateDatabase({ migrate: false });
    try {
      expect((await createBotChatIdsLookup(db)(OWNER, ["chat_plain"])).size).toBe(0);
    } finally {
      await destroy();
    }
  });
});
