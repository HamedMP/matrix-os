import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainFeatureError, type BrainResolvedProject } from "../../packages/gateway/src/brain/contracts.js";
import { createMatrixChatAdapter } from "../../packages/gateway/src/brain/sources/matrix/chat.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixChatHandler, type BrainMatrixChatReader,
} from "../../packages/gateway/src/brain/sources/matrix/index.js";
import type { BrainMatrixChatMessage } from "../../packages/gateway/src/brain/sources/matrix/types.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { createMatrixSource, liveTitles, matrixScope, runMatrixLoop, wideLimits } from "./helpers/brain-source-matrix-loop.js";

const project: BrainResolvedProject = { projectId: "proj_a", slug: "a", name: "A", scope: matrixScope };
const owner = { type: "personal" as const, ownerId: "owner_a" };
let harness: BrainHarness;
let chats: Map<string, { title: string; messages: BrainMatrixChatMessage[] }>;

function message(seq: number, createdAt: string, text: string, extra: Partial<BrainMatrixChatMessage> = {}): BrainMatrixChatMessage {
  return { seq, role: "user", state: "committed", parts: [{ type: "text", text }], createdAt, ...extra };
}
function many(from: number, count: number, day: string, text = "m"): BrainMatrixChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(from + index, `${day}T09:00:00.000Z`, text));
}

const reader: BrainMatrixChatReader = {
  get: async (who, chatId) => {
    const chat = who.ownerId === "owner_a" ? chats.get(chatId) : undefined;
    return chat === undefined ? null : { chat: { id: chatId, title: chat.title, updatedAt: "2026-10-01T00:00:00.000Z" } };
  },
  getMessages: async (_who, chatId, { afterSeq, limit }) =>
    (chats.get(chatId)?.messages ?? []).filter((item) => item.seq > afterSeq).slice(0, limit),
  list: async () => ({ items: [] }),
};

beforeEach(async () => {
  chats = new Map();
  harness = await createBrainHarness();
  await bootstrapBrainMatrixDatabase(harness.db);
});
afterEach(async () => {
  await harness.destroy();
  vi.restoreAllMocks();
});

async function source(chatIds: string[]) {
  const handler = createBrainMatrixChatHandler({ kysely: harness.db, chats: reader, now: harness.now });
  const config = handler.parseConfig({ chatIds });
  const { externalRef } = handler.identify(project, config);
  const sourceId = await createMatrixSource(harness, "matrix_chat", externalRef);
  const resolution = await handler.createAdapter("owner_a", project, config);
  if (!resolution.ok) throw new Error("adapter");
  return { handler, config, externalRef, sourceId, adapter: resolution.adapter };
}

describe("matrix chat source", () => {
  it("writes one document per chat day from committed text, only for opted-in chats", async () => {
    chats.set("chat_a", { title: "Alpha", messages: [
      message(1, "2026-10-01T08:00:00.000Z", "hello", { actorId: "u1" }),
      message(2, "2026-10-01T08:01:00.000Z", "hi there", { role: "assistant" }),
      message(3, "2026-10-01T08:02:00.000Z", "tool", { role: "tool" }),
      message(4, "2026-10-01T08:03:00.000Z", "draft", { state: "pending" }),
      message(5, "2026-10-01T08:04:00.000Z", "", { parts: [{ type: "tool_request" }] }),
      message(6, "2026-10-02T07:00:00.000Z", "next day"),
      message(7, "2026-10-01T23:59:00.000Z", "late clock"),
    ] });
    chats.set("chat_c", { title: "", messages: [message(1, "not a date", "odd")] });
    chats.set("chat_z", { title: "Other", messages: [message(1, "2026-10-01T08:00:00.000Z", "not opted in")] });
    chats.set("chat_e", { title: "Empty", messages: [] });
    const { adapter, config, externalRef, sourceId } = await source(["chat_a", "chat_b", "chat_c", "chat_e"]);
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ caughtUp: true, written: 3 });
    expect(await liveTitles(harness, sourceId)).toEqual(["Alpha - 2026-10-01", "Alpha - 2026-10-02", "Chat - 1970-01-01"]);
    const docs = (await harness.repository.listDocuments(matrixScope, { sourceId })).items;
    const day1 = await harness.repository.getDocument(matrixScope, docs.find((d) => d.title === "Alpha - 2026-10-01")!.documentId);
    expect(day1!.body).toBe("[08:00] user: hello\n[08:01] assistant: hi there");
    expect(day1!.sourceUpdatedAt).toBe("2026-10-01T08:01:00.000Z");
    const day2 = docs.find((d) => d.title === "Alpha - 2026-10-02")!;
    expect(await harness.repository.listDocumentRefs(matrixScope, day2.documentId)).toEqual([
      { kind: "chat", value: "chat_a" }, { kind: "participant", value: "matrix:owner_a" },
    ]);
    expect((await harness.repository.getDocument(matrixScope, day2.documentId))!.body).toBe("[07:00] user: next day\n[23:59] user: late clock");
    expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).written).toBe(0);

    chats.get("chat_a")!.messages.push(message(8, "2026-10-02T09:00:00.000Z", "more"));
    expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).written).toBe(1);
    chats.delete("chat_c");
    const swept = await runMatrixLoop(harness, sourceId, externalRef, adapter, { chatIds: ["chat_b", "chat_c"] }, {
      limits: { ...wideLimits, maxDeletions: 1 },
    });
    expect(swept).toMatchObject({ caughtUp: true, deleted: 3 });
  });

  it("splits a long day into parts and caps parts and messages per day across pages", async () => {
    chats.set("chat_a", { title: "Big", messages: Array.from({ length: 70 }, (_, index) =>
      message(index + 1, "2026-10-01T10:00:00.000Z", "w".repeat(9_000))) });
    chats.set("chat_b", { title: "Busy", messages: [...many(1, 9_000, "2026-10-01"), ...many(9_001, 2, "2026-10-02")] });
    const { adapter, config, externalRef, sourceId } = await source(["chat_a", "chat_b"]);
    const result = await runMatrixLoop(harness, sourceId, externalRef, adapter, config);
    expect(result).toMatchObject({ caughtUp: true, written: 10, notices: ["items_truncated"] });
    expect(result.pages).toBe(4);
    const titles = await liveTitles(harness, sourceId);
    expect(titles).toContain("Big - 2026-10-01 (part 8)");
    expect(titles).not.toContain("Big - 2026-10-01 (part 9)");
    const busy = (await harness.repository.listDocuments(matrixScope, { sourceId })).items.find((d) => d.title === "Busy - 2026-10-01")!;
    expect((await harness.repository.getDocument(matrixScope, busy.documentId))!.body.split("\n")).toHaveLength(2_000);
  });

  it("keeps a whole day when a page ends after a chat's last day and the day then grows", async () => {
    chats.set("chat_a", { title: "A", messages: [
      message(1, "2026-10-01T08:00:00.000Z", "first"), message(2, "2026-10-01T08:01:00.000Z", "second"),
    ] });
    const { adapter, config, externalRef, sourceId } = await source(["chat_a"]);
    const body = async () => {
      const [doc] = (await harness.repository.listDocuments(matrixScope, { sourceId })).items;
      return (await harness.repository.getDocument(matrixScope, doc!.documentId))!.body;
    };
    // maxUpserts 8 leaves no room for another day after the first one, so the page ends right after it.
    const onePage = { limits: { ...wideLimits, maxUpserts: 8 }, maxPages: 1 };
    await runMatrixLoop(harness, sourceId, externalRef, adapter, config, onePage);
    chats.get("chat_a")!.messages.push(message(3, "2026-10-01T09:00:00.000Z", "third"));
    await runMatrixLoop(harness, sourceId, externalRef, adapter, config, onePage);
    expect(await body()).toBe("[08:00] user: first\n[08:01] user: second");
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ caughtUp: true, written: 1 });
    expect(await body()).toBe("[08:00] user: first\n[08:01] user: second\n[09:00] user: third");
  });

  it("starts the next chat on a new page when the chat before used up the read budget", async () => {
    // 50 + 4,150 messages reach the 4,200 read budget exactly as chat_b runs out, so chat_c waits for the next page.
    chats.set("chat_a", { title: "A", messages: many(1, 50, "2026-10-01") });
    chats.set("chat_b", { title: "B", messages: many(1, 4_150, "2026-10-01") });
    chats.set("chat_c", { title: "C", messages: many(1, 1, "2026-10-01") });
    const { adapter, config, externalRef, sourceId } = await source(["chat_a", "chat_b", "chat_c"]);
    const reads = vi.spyOn(reader, "getMessages");
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config, { maxPages: 1 }))
      .toMatchObject({ written: 2, notices: ["items_truncated"] });
    expect(reads.mock.calls.map(([, chatId]) => chatId)).not.toContain("chat_c");
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).toMatchObject({ caughtUp: true, written: 1 });
    expect(await liveTitles(harness, sourceId)).toEqual(["A - 2026-10-01", "B - 2026-10-01", "C - 2026-10-01"]);
  });

  it("refuses small limits, foreign cursors, failing readers and aborted runs", async () => {
    chats.set("chat_a", { title: "A", messages: [message(1, "2026-10-01T08:00:00.000Z", "x")] });
    const { adapter, config, externalRef, sourceId } = await source(["chat_a"]);
    const small = await runMatrixLoop(harness, sourceId, externalRef, adapter, config, { limits: { ...wideLimits, maxUpserts: 4 } });
    expect(small.failure).toEqual({ ok: false, code: "invalid_options" });
    const controller = new AbortController();
    controller.abort();
    expect(await runMatrixLoop(harness, sourceId, externalRef, adapter, config, { signal: controller.signal, maxPages: 1 }))
      .toMatchObject({ pages: 1, written: 0 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createMatrixChatAdapter({ ...reader, get: async () => { throw new Error("db"); } }, owner);
    expect((await runMatrixLoop(harness, sourceId, externalRef, failing, config)).failure).toEqual({ ok: false, code: "provider_unavailable" });
    await harness.repository.applySyncBatch(matrixScope, {
      sourceId, expectedCursor: (await harness.repository.getSyncCursor(matrixScope, sourceId))!.cursor,
      nextCursor: "mc1:e30", upserts: [], deletions: [],
    });
    expect((await runMatrixLoop(harness, sourceId, externalRef, adapter, config)).failure).toEqual({ ok: false, code: "cursor_invalid" });
  });

  it("parses chat ids, gates the owner and lists chats to opt in", async () => {
    const handler = createBrainMatrixChatHandler({ kysely: harness.db, chats: reader });
    expect(handler.parseConfig({ chatIds: ["chat_b", "chat_a"] })).toEqual({ chatIds: ["chat_a", "chat_b"] });
    const tooMany = Array.from({ length: 51 }, (_, index) => `chat_${index}`);
    for (const chatIds of [[], tooMany, ["chat_a", "chat_a"], ["room_a"], ["chat_a b"]]) {
      expect(() => handler.parseConfig({ chatIds })).toThrow(BrainFeatureError);
    }
    expect(handler.identify(project, { chatIds: ["chat_a"] })).toEqual({ externalRef: "matrix_chat", label: "Chats (1)" });
    expect(handler.viewConfig({ chatIds: ["chat_a"] })).toEqual({ chatIds: ["chat_a"] });
    expect(await handler.availability("owner_a")).toEqual({ available: true });
    expect(await handler.availability("bad owner")).toEqual({ available: false, reason: "not_connected" });
    expect(await handler.createAdapter("a..b", project, { chatIds: ["chat_a"] })).toEqual({ ok: false, code: "not_connected" });
    const off = createBrainMatrixChatHandler({ kysely: harness.db, chats: null });
    expect(await off.availability("owner_a")).toEqual({ available: false, reason: "not_configured" });
    expect(await off.createAdapter("owner_a", project, { chatIds: ["chat_a"] })).toEqual({ ok: false, code: "not_connected" });
    const signal = new AbortController().signal;
    expect(await off.listOptions!("owner_a", project, {}, signal)).toEqual({ kind: "matrix_chat", items: [], nextCursor: null });
    const sourceId = await createMatrixSource(harness, "matrix_chat", "matrix_chat");
    expect(await handler.loadConfig(matrixScope, sourceId)).toBeNull();
    expect(await handler.listOptions!("owner_a", project, {}, signal)).toEqual({ kind: "matrix_chat", items: [], nextCursor: null });
    await handler.saveConfig(matrixScope, sourceId, { chatIds: ["chat_a"] });
    expect(await handler.loadConfig(matrixScope, sourceId)).toEqual({ chatIds: ["chat_a"] });

    const list = vi.fn<BrainMatrixChatReader["list"]>(async () => ({
      items: [
        { chat: { id: "chat_a", title: "Roadmap talk", activityAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z" } },
        { chat: { id: "chat_b", title: "Lunch", updatedAt: "2026-09-30T10:00:00.000Z" } },
      ],
      nextCursor: { activityAt: "2026-09-30T10:00:00.000Z", chatId: "chat_b" },
    }));
    const listing = createBrainMatrixChatHandler({ kysely: harness.db, chats: { ...reader, list } });
    const first = await listing.listOptions!("owner_a", project, { q: "road" }, signal);
    expect(first.items).toEqual([{ id: "chat_a", label: "Roadmap talk", detail: "2026-10-01" }]);
    const second = await listing.listOptions!("owner_a", project, { cursor: first.nextCursor! }, signal);
    expect(second.items.map((item) => item.detail)).toEqual(["2026-10-01", "2026-09-30"]);
    expect(list).toHaveBeenLastCalledWith(owner, {
      limit: 100, lifecycle: "active", cursor: { activityAt: "2026-09-30T10:00:00.000Z", chatId: "chat_b" },
    });
    await expect(listing.listOptions!("owner_a", project, { cursor: "bad" }, signal)).rejects.toThrow(BrainFeatureError);
    await expect(listing.listOptions!("owner_a", project, { q: "x".repeat(201) }, signal)).rejects.toThrow(BrainFeatureError);
  });
});
