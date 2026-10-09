import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createChatNavigationRepository } from "../../packages/gateway/src/chat/navigation-repository.js";
const owner = { type: "personal" as const, ownerId: "source_owner" };
describe("durable Chat import source", () => {
  let chats: ChatRepository;
  beforeEach(async () => { const pg = await KyselyPGlite.create(); chats = new ChatRepository(pg.dialect); await chats.bootstrap();
    await sql`CREATE TABLE bot_chat_bindings (owner_id TEXT,bot_id TEXT,chat_id TEXT,kind TEXT,removed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now())`.execute(chats.kysely); });
  afterEach(async () => { await chats.kysely.destroy(); });
  async function seed(suffix: string, harness: "claude" | "codex", status = "published", ownerId = owner.ownerId) {
    const record = await chats.create(owner, { id: `chat_${suffix}`, clientRequestId: `req_${suffix}`, title: suffix });
    const id = randomUUID();
    await sql`INSERT INTO local_chat_import_jobs (id,owner_id,harness,source_id,source_hash,raw_size,title,status,object_key,chat_id,expires_at)
      VALUES (${id}::uuid,${ownerId},${harness},${randomUUID()}::uuid,${"a".repeat(64)},1,${suffix},${status},${id},${record.chat.id},now()+interval '1 day')`.execute(chats.kysely);
    return record.chat.id;
  }
  it("bootstraps owner/chat provenance indexes idempotently for bounded list lookups", async () => {
    await chats.bootstrap();
    const rows = await sql<{ indexname: string; indexdef: string }>`SELECT indexname,indexdef FROM pg_indexes
      WHERE indexname IN ('idx_local_chat_import_published_chat','idx_chat_legacy_import_verified_chat')`.execute(chats.kysely);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.find(row => row.indexname === 'idx_local_chat_import_published_chat')?.indexdef).toContain('(owner_id, chat_id)');
    expect(rows.rows.find(row => row.indexname === 'idx_chat_legacy_import_verified_chat')?.indexdef).toContain('(owner_type, owner_id, chat_id)');
  });
  it("reads both sources in details, ordinary list and one-statement navigation independently of live selection", async () => {
    const claude = await seed("claude", "claude"); const codex = await seed("codex", "codex");
    const plain = await chats.create(owner, { id: "chat_plain", clientRequestId: "req_plain", title: "Imported from Codex", currentSelection: { instanceId: "codex_live", model: "model" } });
    const current = await chats.get(owner, claude);
    await chats.update(owner, claude, { baseRevision: current!.chat.revision, currentSelection: { instanceId: "codex_live", model: "different" } });
    expect(await chats.get(owner, claude)).toMatchObject({ importSource: { harness: "claude" } });
    expect(await chats.get(owner, codex)).toMatchObject({ importSource: { harness: "codex" } });
    expect(await chats.get(owner, plain.chat.id)).not.toHaveProperty("importSource");
    const list = (await chats.list(owner, { limit: 100 })).items;
    expect(list.find(r => r.chat.id === claude)).toMatchObject({ importSource: { harness: "claude" } });
    expect(list.find(r => r.chat.id === codex)).toMatchObject({ importSource: { harness: "codex" } });
    const nav = await createChatNavigationRepository(chats.kysely).list(owner, { version: 1, limit: 100 });
    expect(nav.items.find(r => r.chat.id === claude)).toMatchObject({ importSource: { harness: "claude" } });
    expect(nav.items.find(r => r.chat.id === codex)).toMatchObject({ importSource: { harness: "codex" } });
  });
  it("excludes unpublished, failed and foreign-owner provenance and never crosses owner types", async () => {
    for (const [suffix, status, ownerId] of [["pending", "verifying", owner.ownerId], ["failed", "failed", owner.ownerId], ["foreign", "published", "foreign"]]) {
      const id = await seed(suffix!, "claude", status, ownerId);
      expect(await chats.get(owner, id)).not.toHaveProperty("importSource");
    }
    const org = await chats.create({ type: "organization", ownerId: owner.ownerId }, { id: "chat_org", clientRequestId: "req_org", title: "Org" });
    await sql`INSERT INTO local_chat_import_jobs (id,owner_id,harness,source_id,source_hash,raw_size,title,status,object_key,chat_id,expires_at)
      VALUES (${randomUUID()}::uuid,${owner.ownerId},'codex',${randomUUID()}::uuid,${"b".repeat(64)},1,'Org','published','org',${org.chat.id},now())`.execute(chats.kysely);
    expect(await chats.get({ type: "organization", ownerId: owner.ownerId }, org.chat.id)).not.toHaveProperty("importSource");
    expect((await chats.list(owner, { limit: 100 })).items.every(r => !("importSource" in r))).toBe(true);
    expect((await createChatNavigationRepository(chats.kysely).list(owner, { version: 1, limit: 100 })).items.every(r => !("importSource" in r))).toBe(true);
    expect(await chats.get({ type: "personal", ownerId: "foreign" }, "chat_foreign")).toBeNull();
  });
  it("retains verified legacy Codex provenance but excludes incomplete legacy entries", async () => {
    for (const status of ["verified", "pending", "failed"] as const) {
      const id = `chat_legacy_${status}`;
      await chats.create(owner, { id, clientRequestId: `req_${status}`, title: status });
      await chats.kysely.insertInto("chat_legacy_imports").values({ owner_type: owner.type, owner_id: owner.ownerId, source_kind: "codex_jsonl", source_id: status, chat_id: id, source_hash: "a".repeat(64), import_version: 1, verification_status: status }).execute();
      const record = await chats.get(owner, id);
      if (status === "verified") expect(record).toMatchObject({ importSource: { harness: "codex" } });
      else expect(record).not.toHaveProperty("importSource");
    }
  });
});
