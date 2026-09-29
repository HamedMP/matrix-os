import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CodexChatImporter } from "../../packages/gateway/src/chat/codex-importer.js";
import { canonicalChatPresentation } from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation.js";

const owner = { type: "personal" as const, ownerId: "ash_test" };
const other = { type: "personal" as const, ownerId: "nithin_test" };
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const sourceHash = "a".repeat(64);

describe("Codex Chat import", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let chats: ChatRepository;
  let importer: CodexChatImporter;

  beforeEach(async () => {
    pg = await KyselyPGlite.create();
    chats = new ChatRepository(pg.dialect);
    await chats.bootstrap();
    importer = new CodexChatImporter(chats);
  });

  afterEach(async () => { await chats.kysely.destroy(); });

  it("publishes a complete private Chat once and preserves roles, order and timestamps", async () => {
    const delivered: string[] = [];
    const subscription = chats.registerOutboxSink(({ event }) => delivered.push(event.eventType));
    expect(await importer.begin(owner, { sourceId, sourceHash, title: "Fix login" }))
      .toMatchObject({ status: "uploading", nextSeq: 1 });
    await importer.append(owner, sourceId, { startSeq: 1, messages: [
      { role: "user", text: "Fix login", createdAt: "2026-09-03T16:01:00.000Z" },
      { role: "assistant", text: "Fixed it.", createdAt: "2026-09-03T16:03:00.000Z" },
    ] });

    const result = await importer.complete(owner, sourceId, { messageCount: 2 });
    expect(delivered).toEqual(["chat.created"]);
    subscription.dispose();
    expect(result).toMatchObject({ messageCount: 2 });
    const detail = await chats.getDetailPage(owner, result.chatId, { limit: 10 });
    expect(detail?.record.chat).toMatchObject({ title: "Fix login", messageCount: 2,
      ownerScope: owner });
    expect(detail?.messages.map((message) => ({ role: message.role, text: message.parts[0],
      createdAt: message.createdAt }))).toEqual([
      { role: "user", text: { type: "text", text: "Fix login" }, createdAt: "2026-09-03T16:01:00.000Z" },
      { role: "assistant", text: { type: "text", text: "Fixed it." }, createdAt: "2026-09-03T16:03:00.000Z" },
    ]);
    expect(detail?.turns).toHaveLength(1);
    expect(detail?.messages.every((message) => message.turnId === detail.turns[0]?.id)).toBe(true);
    expect(canonicalChatPresentation(detail!)[0]).toMatchObject({
      user: { markdown: "Fix login" },
      final: { markdown: "Fixed it." },
    });
    expect(await chats.kysely.selectFrom("chat_import_jobs").select("source_id").execute()).toEqual([]);
    expect(await importer.complete(owner, sourceId, { messageCount: 2 })).toEqual(result);
    expect(await chats.get(other, result.chatId)).toBeNull();
    expect(await importer.begin(owner, { sourceId, sourceHash, title: "Fix login" }))
      .toMatchObject({ status: "verified", chatId: result.chatId, nextSeq: 3 });
  });

  it("keeps incomplete imports invisible and expires abandoned staging rows", async () => {
    await importer.begin(owner, { sourceId, sourceHash, title: "Unfinished" });
    expect(await importer.begin(owner, { sourceId, sourceHash, title: "Edited title" }))
      .toMatchObject({ status: "uploading", nextSeq: 1 });
    expect(await chats.kysely.selectFrom("chat_import_jobs").select("title").executeTakeFirst())
      .toMatchObject({ title: "Edited title" });
    await importer.append(owner, sourceId, { startSeq: 1, messages: [
      { role: "user", text: "Hello", createdAt: "2026-09-03T16:01:00.000Z" },
    ] });
    await expect(importer.complete(owner, sourceId, { messageCount: 2 }))
      .rejects.toMatchObject({ code: "incomplete" });
    expect((await chats.list(owner, { limit: 10 })).items).toEqual([]);
    await expect(importer.begin(owner, { sourceId, sourceHash: "b".repeat(64), title: "Unfinished" }))
      .rejects.toMatchObject({ code: "conflict" });

    expect(await importer.sweepExpired(new Date(Date.now() + 25 * 60 * 60_000))).toBe(1);
    expect(await chats.kysely.selectFrom("chat_import_messages").select("seq").execute()).toEqual([]);
    expect(await importer.begin(owner, { sourceId, sourceHash: "b".repeat(64), title: "Retry" }))
      .toMatchObject({ status: "uploading", nextSeq: 1 });
  });

  it("shows every turn in a full Chat detail page", async () => {
    await importer.begin(owner, { sourceId, sourceHash, title: "Long history" });
    for (let start = 1; start <= 150; start += 50) {
      await importer.append(owner, sourceId, { startSeq: start,
        messages: Array.from({ length: 50 }, (_, offset) => ({
          role: "user" as const, text: `Question ${start + offset}`,
          createdAt: new Date(Date.UTC(2026, 8, 3, 16, start + offset)).toISOString(),
        })) });
    }
    const { chatId } = await importer.complete(owner, sourceId, { messageCount: 150 });
    const detail = await chats.getDetailPage(owner, chatId, { limit: 200 });
    expect(detail?.messages).toHaveLength(150);
    expect(detail?.turns).toHaveLength(150);
    expect(canonicalChatPresentation(detail!).map((turn) => turn.user?.markdown))
      .toEqual(Array.from({ length: 150 }, (_, index) => `Question ${index + 1}`));
  });

  it("does not strand a job when a retry overlaps completion", async () => {
    await importer.begin(owner, { sourceId, sourceHash, title: "Concurrent" });
    await importer.append(owner, sourceId, { startSeq: 1, messages: [
      { role: "user", text: "Hello", createdAt: "2026-09-03T16:01:00.000Z" },
    ] });
    const [completed, retry] = await Promise.all([
      importer.complete(owner, sourceId, { messageCount: 1 }),
      importer.begin(owner, { sourceId, sourceHash, title: "Concurrent" }),
    ]);
    expect(["uploading", "verified"]).toContain(retry.status);
    expect(await importer.begin(owner, { sourceId, sourceHash, title: "Concurrent" }))
      .toMatchObject({ status: "verified", chatId: completed.chatId });
    expect(await chats.kysely.selectFrom("chat_import_jobs").select("source_id").execute()).toEqual([]);
  });

  it("does not report success for an imported Chat that the owner deleted", async () => {
    await importer.begin(owner, { sourceId, sourceHash, title: "Deleted" });
    await importer.append(owner, sourceId, { startSeq: 1, messages: [
      { role: "user", text: "Hello", createdAt: "2026-09-03T16:01:00.000Z" },
    ] });
    const result = await importer.complete(owner, sourceId, { messageCount: 1 });
    await chats.hardDelete(owner, { chatId: result.chatId, clientRequestId: "req_delete_imported" });
    await expect(importer.begin(owner, { sourceId, sourceHash, title: "Deleted" }))
      .rejects.toMatchObject({ code: "conflict" });
  });
});
