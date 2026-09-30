import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { LocalChatImportJobs } from "../../packages/gateway/src/chat/local-import/jobs.js";
import { LocalChatImportPublisher } from "../../packages/gateway/src/chat/local-import/publication.js";
const owner = { type: "personal" as const, ownerId: "synthetic_import_owner" };
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const transcript = (body: unknown[]) => body.map(record => JSON.stringify(record)).join("\n") + "\n";
const header = { type: "session_meta", payload: { id: sourceId, timestamp: "2026-09-30T00:00:00Z" } };
function storage() { return { headObject: vi.fn(async () => ({ exists: false })), listMultipartUploads: vi.fn(async () => []),
  createMultipartUpload: vi.fn(async () => "upload"), getPresignedPartUrl: vi.fn(async () => "https://storage.example.test/part"),
  completeMultipartUpload: vi.fn(async () => ({ etag: "complete" })), abortMultipartUpload: vi.fn(async () => {}),
  deleteObject: vi.fn(async (_key: string) => {}), putObject: vi.fn(async (_key: string, _bytes: Uint8Array, _mime: string) => ({ etag: "asset" })),
  getPresignedGetUrl: vi.fn(async () => "https://storage.example.test/original"),
}; }
describe("verified private archives publish canonical Chat atomically", () => {
  let chats: ChatRepository; let jobs: LocalChatImportJobs; let r2: ReturnType<typeof storage>;
  beforeEach(async () => { const pg = await KyselyPGlite.create(); chats = new ChatRepository(pg.dialect); await chats.bootstrap();
    r2 = storage(); jobs = new LocalChatImportJobs({ repository: chats, storage: r2, runtimeOwnerId: owner.ownerId }); });
  afterEach(async () => { await chats.kysely.destroy(); });
  async function uploaded(raw: string, wrongHash = false) {
    const sourceHash = wrongHash ? "a".repeat(64) : createHash("sha256").update(raw).digest("hex");
    const job = await jobs.begin(owner, { harness: "codex", sourceId, sourceHash, rawSize: Buffer.byteLength(raw), title: "Synthetic imported history" });
    await jobs.acknowledgePart(owner, job.jobId, { partNumber: 1, etag: "part", size: Buffer.byteLength(raw) });
    await jobs.completeArchive(owner, job.jobId); return job.jobId;
  }
  function publisher(raw: string) { return new LocalChatImportPublisher({ repository: chats, storage: r2, runtimeOwnerId: owner.ownerId,
    fetchImpl: vi.fn(async () => new Response(raw)) as unknown as typeof fetch }); }
  it("publishes assistant-only history without inventing a human message, Turn, or Run", async () => {
    const raw = transcript([header, { type: "response_item", payload: { type: "message", role: "assistant", id: "answer", phase: "final_answer", content: [{ type: "output_text", text: "Saved answer" }] } }]);
    const jobId = await uploaded(raw); const p = publisher(raw); const result = await p.publish(owner, jobId);
    const exported = await chats.exportChat(owner, result.chatId);
    expect(exported?.messages).toHaveLength(1); expect(exported?.messages[0]).toMatchObject({ role: "assistant", parts: expect.arrayContaining([{ type: "text", text: "Saved answer" }]) });
    expect(exported?.turns).toEqual([]); expect(exported?.runs).toEqual([]);
    expect((await p.publish(owner, jobId)).chatId).toBe(result.chatId);
    await expect(p.archiveUrl({ type: "personal", ownerId: "foreign" }, jobId)).rejects.toMatchObject({ code: "not_found" });
    expect((await chats.list(owner, { limit: 10 })).items).toHaveLength(1);
  });
  it("keeps all staged history and assets invisible when the final archive hash is wrong", async () => {
    const raw = transcript([header, { type: "response_item", payload: { type: "message", role: "assistant", id: "large", content: [{ type: "output_text", text: "x".repeat(12_000) }] } }]);
    const jobId = await uploaded(raw, true);
    await expect(publisher(raw).publish(owner, jobId)).rejects.toMatchObject({ code: "checksum_mismatch" });
    expect((await chats.list(owner, { limit: 10 })).items).toEqual([]);
    const job = await chats.kysely.selectFrom("local_chat_import_jobs").selectAll().where("id", "=", jobId).executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: "failed", cleanup_pending: true, chat_id: null });
    expect(r2.putObject).toHaveBeenCalledTimes(1);
    const assets = await chats.kysely.selectFrom("local_chat_import_assets").selectAll().where("job_id", "=", jobId).execute();
    expect(assets[0]).toMatchObject({ cleanup_pending: true, chat_id: null });
  });
  it("keeps a human Turn, all 37 results, and actual source ordering without live execution", async () => {
    const records: unknown[] = [header, { type: "response_item", payload: { type: "message", role: "user", id: "user", content: [{ type: "input_text", text: "Synthetic prompt" }] } },
      { type: "response_item", payload: { type: "function_call", call_id: "call", name: "synthetic", arguments: "{}" } }];
    for (let n = 0; n < 37; n++) records.push({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: `Result ${n}` } });
    records.push({ type: "response_item", payload: { type: "message", role: "assistant", id: "answer", phase: "final_answer", content: [{ type: "output_text", text: "Finished" }] } });
    const raw = transcript(records); const result = await publisher(raw).publish(owner, await uploaded(raw));
    const exported = await chats.exportChat(owner, result.chatId);
    expect(exported?.messages).toHaveLength(40); expect(exported?.turns).toHaveLength(1); expect(exported?.runs).toHaveLength(0);
    const results = exported?.messages.flatMap(message => message.parts).filter(part => part.type === "tool_result");
    expect(results).toHaveLength(37); expect(results?.map(part => part.type === "tool_result" ? part.text : "")).toEqual(Array.from({ length: 37 }, (_, n) => `Result ${n}`));
    expect(exported?.messages.every(message => message.turnId === exported.turns[0]?.id)).toBe(true);
    expect((await chats.kysely.selectFrom("chat_members").selectAll().where("chat_id", "=", result.chatId).execute()).map(row => row.principal_id)).toEqual([owner.ownerId]);
  });
  it("retries exact private asset cleanup after failed verification without touching another job", async () => {
    const raw = transcript([header, { type: "response_item", payload: { type: "message", role: "assistant", id: "large", content: [{ type: "output_text", text: "x".repeat(12_000) }] } }]);
    const jobId = await uploaded(raw, true); const p = publisher(raw);
    await expect(p.publish(owner, jobId)).rejects.toMatchObject({ code: "checksum_mismatch" });
    r2.deleteObject.mockRejectedValueOnce(new Error("temporary failure"));
    await p.sweepPrivateArtifacts();
    expect(await chats.kysely.selectFrom("local_chat_import_assets").selectAll().where("job_id", "=", jobId).execute()).toHaveLength(1);
    await p.sweepPrivateArtifacts();
    expect(await chats.kysely.selectFrom("local_chat_import_assets").selectAll().where("job_id", "=", jobId).execute()).toHaveLength(0);
    expect(r2.deleteObject.mock.calls.every(([key]) => typeof key === "string" && key.includes(`/files/.chat-imports/${jobId}/assets/`))).toBe(true);
  });
  it("streams an authorized full asset through the gateway and verifies its bytes", async () => {
    const text = "x".repeat(12_000);
    const raw = transcript([header, { type: "response_item", payload: { type: "message", role: "assistant", id: "large", content: [{ type: "output_text", text }] } }]);
    const result = await publisher(raw).publish(owner, await uploaded(raw));
    const asset = await chats.kysely.selectFrom("local_chat_import_assets").selectAll().where("chat_id", "=", result.chatId).executeTakeFirstOrThrow();
    const p = publisher(text); const response = await p.assetContent(owner, result.chatId, asset.id);
    expect(response.headers.get("content-type")).toBe("text/plain"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(text);
    await expect(p.assetContent({ type: "personal", ownerId: "foreign" }, result.chatId, asset.id)).rejects.toMatchObject({ code: "not_found" });
    const damaged = await publisher("wrong").assetContent(owner, result.chatId, asset.id);
    await expect(damaged.text()).rejects.toThrow();
  });
  it("checks the exact runtime owner before storage and never signs another archive", async () => {
    const p = publisher(""); await expect(p.publish({ type: "personal", ownerId: "foreign" }, sourceId)).rejects.toMatchObject({ code: "not_found" });
    expect(r2.getPresignedGetUrl).not.toHaveBeenCalled();
  });
  it("cleans expired text-only staging even when no private assets were created", async () => {
    const raw = transcript([header, { type: "response_item", payload: { type: "message", role: "assistant", id: "short", content: [{ type: "output_text", text: "Synthetic staging" }] } }]);
    const jobId = await uploaded(raw);
    await chats.kysely.insertInto("local_chat_import_records").values({ job_id: jobId, record_key: "a".repeat(64), logical_key: "b".repeat(64),
      source_offset: 0, source_block: 0, chunk: 0, role: "assistant", parts: JSON.stringify([]), created_at: new Date() }).execute();
    await chats.kysely.updateTable("local_chat_import_jobs").set({ status: "expired", cleanup_pending: true }).where("id", "=", jobId).execute();
    await publisher(raw).sweepPrivateArtifacts();
    expect(await chats.kysely.selectFrom("local_chat_import_records").selectAll().where("job_id", "=", jobId).execute()).toEqual([]);
    expect(r2.deleteObject).not.toHaveBeenCalled();
  });

});
