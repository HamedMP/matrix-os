import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createLiveHistory } from "../../../packages/gateway/src/live-companion/history.js";

const owner = { type: "personal" as const, ownerId: "alice" };
let db: Awaited<ReturnType<typeof KyselyPGlite.create>>;
let chats: ChatRepository;
beforeEach(async () => {
  db = await KyselyPGlite.create();
  chats = new ChatRepository(db.dialect);
  await chats.bootstrap();
  await chats.create(owner, { id: "chat_live", clientRequestId: "req_live", title: "Aoede" });
});
afterEach(async () => { await chats.release(); await chats.kysely.destroy(); });
describe("canonical live conversation history", () => {
  it("restores the most recent bounded turns rather than the first conversation", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    for (let n = 0; n < 22; n++) await history.journal({ id: `vturn_${n}`, role: "user", text: `Turn ${n}` });
    const restored = await history.restore();
    expect(restored).toHaveLength(20);
    expect(restored[0]?.text).toBe("Turn 2");
    expect(restored.at(-1)?.text).toBe("Turn 21");
  });
  it("stores casual turns in Chat once, with atomic sequence and revision", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    const input = { id: "vturn_a", role: "user" as const, text: "Hello" };
    await Promise.all([history.journal(input), history.journal(input)]);
    const detail = await chats.getDetailPage(owner, "chat_live", { limit: 20 });
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.record.chat.revision).toBe(1);
    expect(detail?.messages[0]?.purpose).toBe("discussion");
  });
  it("prioritizes the newest turns when the restored byte budget is full", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    await history.journal({ id: "vturn_old", role: "user", text: "a".repeat(8000) });
    await history.journal({ id: "vturn_mid", role: "assistant", text: "b".repeat(8000), heard: true });
    await history.journal({ id: "vturn_new", role: "user", text: "Actually, build a calendar." });
    expect((await history.restore()).at(-1)?.text).toBe("Actually, build a calendar.");
  });
  it("returns bounded source-linked quotes while excluding other owners and projects", async () => {
    for (const [id, who] of [["chat_same", "alice"], ["chat_other_owner", "bob"]]) {
      const scope = { type: "personal" as const, ownerId: who! };
      await chats.create(scope, { id: id!, clientRequestId: `req_${id}`, title: "Tracker discussion" });
      await createLiveHistory(chats, scope, id!).journal({ id: "vturn_one", role: "user", text: "Tracker context ".repeat(150) });
    }
    await chats.create(owner, { id: "chat_other_project", clientRequestId: "req_project", title: "Tracker project", projectId: "project_private" });
    await createLiveHistory(chats, owner, "chat_other_project").journal({ id: "vturn_one", role: "user", text: "Tracker context" });
    const history = createLiveHistory(chats, owner, "chat_live");
    const sources = await history.search("Tracker");
    expect(sources.map(source => source.chatId)).toEqual(["chat_same"]);
    expect(sources[0]?.snippet.length).toBeLessThanOrEqual(1600);
    expect(sources[0]?.title).toBe("Tracker discussion");
    await expect(history.search("x".repeat(161))).rejects.toThrow();
    await expect(createLiveHistory(chats, { type: "personal", ownerId: "bob" }, "chat_live").search("Tracker")).rejects.toThrow();
  });
  it("never restores unheard assistant speech as conversation context", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    await history.journal({ id: "vresp_a", role: "assistant", text: "unheard words", heard: false });
    expect(await history.restore()).toEqual([]);
    expect((await chats.getDetailPage(owner, "chat_live", { limit: 20 }))?.messages[0]?.state).toBe("failed");
  });
  it("denies a different owner and detects changed replay contents", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    await history.journal({ id: "vturn_a", role: "user", text: "Hello" });
    await expect(history.journal({ id: "vturn_a", role: "user", text: "Different" })).rejects.toThrow();
    await expect(createLiveHistory(chats, { type: "personal", ownerId: "bob" }, "chat_live").restore()).rejects.toThrow();
  });
});
