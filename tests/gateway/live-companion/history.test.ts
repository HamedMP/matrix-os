import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
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
  it("quotes the matching older message rather than unrelated recent speech", async () => {
    await chats.create(owner, { id: "chat_source", clientRequestId: "req_source", title: "Planning" });
    const source = createLiveHistory(chats, owner, "chat_source");
    await source.journal({ id: "vturn_match", role: "user", text: "Tracker uses weekly goals." });
    for (let n = 0; n < 7; n++) await source.journal({ id: `vturn_new_${n}`, role: "user", text: "Unrelated recent conversation" });
    const matches = await createLiveHistory(chats, owner, "chat_live").search("Tracker");
    expect(matches[0]?.snippet).toContain("Tracker uses weekly goals.");
  });
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
  it("restores the interruption's confirmed playback fact while excluding unverified words", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    await history.journal({ id: "vresp_partial", role: "assistant", text: "Generated words including an unheard tail", heard: false, playedThroughMs: 10 });
    const context = await history.restore();
    expect(context[0]?.text).toContain("10 ms of confirmed playback");
    expect(context[0]?.text).not.toContain("Generated words including an unheard tail");
    expect(await history.search("Generated words")).toEqual([]);
    await history.journal({ id: "vresp_partial", role: "assistant", text: "Generated words including an unheard tail", heard: false, playedThroughMs: 10 });
    await expect(history.journal({ id: "vresp_partial", role: "assistant", text: "Generated words including an unheard tail", heard: false, playedThroughMs: 20 })).rejects.toThrow();
  });
  it("rejects restoration when the Chat disappears between authorization and the detail read", async () => {
    const detail = vi.spyOn(chats, "getDetailPage").mockResolvedValueOnce(null);
    await expect(createLiveHistory(chats, owner, "chat_live").restore()).rejects.toThrow();
    detail.mockRestore();
  });
  it("denies a different owner and detects changed replay contents", async () => {
    const history = createLiveHistory(chats, owner, "chat_live");
    await history.journal({ id: "vturn_a", role: "user", text: "Hello" });
    await expect(history.journal({ id: "vturn_a", role: "user", text: "Different" })).rejects.toThrow();
    await expect(createLiveHistory(chats, { type: "personal", ownerId: "bob" }, "chat_live").restore()).rejects.toThrow();
    await expect(createLiveHistory(chats, { type: "personal", ownerId: "bob" }, "chat_live").journal({ id: "vturn_b", role: "user", text: "Unauthorized" })).rejects.toThrow();
  });
  it("rolls back the message when the database suppresses the revision write", async () => {
    await sql`CREATE FUNCTION suppress_live_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(chats.kysely);
    await sql`CREATE TRIGGER suppress_live_revision BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION suppress_live_revision()`.execute(chats.kysely);
    await expect(createLiveHistory(chats, owner, "chat_live").journal({ id: "vturn_one", role: "user", text: "Must commit atomically" })).rejects.toThrow();
    expect((await chats.getDetailPage(owner, "chat_live", { limit: 20 }))?.messages).toHaveLength(0);
    expect((await chats.get(owner, "chat_live"))?.chat.revision).toBe(0);
  });
  it("returns matching private-project excerpts and rechecks ownership at the final read", async () => {
    await chats.create(owner, { id: "chat_project_root", clientRequestId: "req_project_root", title: "Voice", projectId: "project_live" });
    await chats.create(owner, { id: "chat_project_source", clientRequestId: "req_project_source", title: "Tracker", projectId: "project_live" });
    await createLiveHistory(chats, owner, "chat_project_source").journal({ id: "vturn_source", role: "user", text: "Tracker project details" });
    const history = createLiveHistory(chats, owner, "chat_project_root");
    expect((await history.search("Tracker"))[0]?.snippet).toContain("Tracker project details");
    const get = chats.get.bind(chats);
    const access = vi.spyOn(chats, "get").mockImplementation(async (scope, id) => {
      const record = await get(scope, id);
      if (id === "chat_project_source") await chats.kysely.updateTable("chats").set({ owner_id: "bob" }).where("id", "=", id).execute();
      return record;
    });
    expect(await history.search("Tracker")).toEqual([]); access.mockRestore();
  });
});
