import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { LocalChatImportJobs } from "../../packages/gateway/src/chat/local-import/jobs.js";
const owner = { type: "personal" as const, ownerId: "import_test_owner" };
const other = { type: "personal" as const, ownerId: "other_owner" };
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const request = { harness: "codex" as const, sourceId, sourceHash: "a".repeat(64), rawSize: 100,
  title: "Synthetic source" };
function storage() {
  return {
    headObject: vi.fn(async (_key: string) => ({ exists: false })),
    listMultipartUploads: vi.fn(async (_key: string) => [] as { key: string; uploadId: string }[]),
    createMultipartUpload: vi.fn(async (_key: string) => "multipart-original"),
    getPresignedPartUrl: vi.fn(async (_key: string, _uploadId: string, number: number) => `https://storage.example.test/part/${number}`),
    completeMultipartUpload: vi.fn(async () => ({ etag: "completed" })),
    abortMultipartUpload: vi.fn(async () => {}), deleteObject: vi.fn(async () => {}),
  };
}
describe("owner-private durable local Chat import jobs", () => {
  let chats: ChatRepository;
  let jobs: LocalChatImportJobs;
  let r2: ReturnType<typeof storage>;
  beforeEach(async () => {
    const pg = await KyselyPGlite.create(); chats = new ChatRepository(pg.dialect); await chats.bootstrap();
    r2 = storage(); jobs = new LocalChatImportJobs({ repository: chats, storage: r2, runtimeOwnerId: owner.ownerId });
  });
  afterEach(async () => { await chats.kysely.destroy(); });
  it("starts an idempotent owner-scoped upload without publishing a Chat", async () => {
    const first = await jobs.begin(owner, request); const retry = await jobs.begin(owner, request);
    expect(retry.jobId).toBe(first.jobId); expect(first).toMatchObject({ status: "uploading", totalParts: 1 });
    expect(r2.createMultipartUpload).toHaveBeenCalledTimes(1);
    expect((await chats.list(owner, { limit: 10 })).items).toEqual([]);
    expect(r2.createMultipartUpload.mock.calls[0]?.[0]).toMatch(new RegExp(`^matrixos-sync/${owner.ownerId}/files/\\.chat-imports/`));
  });
  it("keeps harness identities distinct and rejects another owner before issuing storage access", async () => {
    const a = await jobs.begin(owner, request); const b = await jobs.begin(owner, { ...request, harness: "claude" });
    expect(a.jobId).not.toBe(b.jobId);
    await expect(jobs.begin(other, request)).rejects.toMatchObject({ code: "not_found" });
    await expect(jobs.get(other, a.jobId)).rejects.toMatchObject({ code: "not_found" });
    await expect(jobs.presignParts(other, a.jobId, { partNumbers: [1] })).rejects.toMatchObject({ code: "not_found" });
    expect(r2.getPresignedPartUrl).not.toHaveBeenCalled();
  });
  it("retains acknowledged parts for restart and bounds part numbers", async () => {
    const first = await jobs.begin(owner, { ...request, rawSize: 70 * 1024 * 1024 });
    expect(first.totalParts).toBe(2);
    expect(await jobs.presignParts(owner, first.jobId, { partNumbers: [1, 2] })).toHaveLength(2);
    await jobs.acknowledgePart(owner, first.jobId, { partNumber: 1, etag: '"part-one"', size: 64 * 1024 * 1024 });
    const restarted = new LocalChatImportJobs({ repository: chats, storage: r2, runtimeOwnerId: owner.ownerId });
    expect(await restarted.get(owner, first.jobId)).toMatchObject({ parts: [{ partNumber: 1, etag: '"part-one"', size: 64 * 1024 * 1024 }] });
    await expect(jobs.presignParts(owner, first.jobId, { partNumbers: [3] })).rejects.toMatchObject({ code: "invalid" });
    await expect(jobs.acknowledgePart(owner, first.jobId, { partNumber: 2, etag: "bad", size: 1 })).rejects.toMatchObject({ code: "invalid" });
  });
  it("does not complete a partial archive, and completion is idempotent", async () => {
    const first = await jobs.begin(owner, request);
    await expect(jobs.completeArchive(owner, first.jobId)).rejects.toMatchObject({ code: "incomplete" });
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
    await jobs.acknowledgePart(owner, first.jobId, { partNumber: 1, etag: "etag", size: 100 });
    expect(await jobs.completeArchive(owner, first.jobId)).toMatchObject({ status: "uploaded" });
    expect(await jobs.completeArchive(owner, first.jobId)).toMatchObject({ status: "uploaded" });
    expect(r2.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });
  it("bounds open jobs and source sizes without exposing partial Chats", async () => {
    for (let n = 0; n < 8; n++) await jobs.begin(owner, { ...request, sourceId: `019eb0ae-9a30-7541-bdb8-db4d17e6514${n}` });
    await expect(jobs.begin(owner, { ...request, sourceId: "019eb0ae-9a30-7541-bdb8-db4d17e65149" })).rejects.toMatchObject({ code: "capacity" });
    await expect(jobs.begin(owner, { ...request, rawSize: 20 * 1024 ** 3 + 1 })).rejects.toMatchObject({ code: "invalid" });
  });
  it("expires only abandoned uploads and retries exact storage cleanup", async () => {
    const first = await jobs.begin(owner, request);
    await jobs.expire(new Date(Date.now() + 25 * 60 * 60_000));
    expect(await jobs.get(owner, first.jobId)).toMatchObject({ status: "expired" });
    expect(r2.abortMultipartUpload).toHaveBeenCalledTimes(1);
    await expect(jobs.presignParts(owner, first.jobId, { partNumbers: [1] })).rejects.toMatchObject({ code: "expired" });
  });
  it("recovers a lost completion response without rewriting the original archive", async () => {
    const first = await jobs.begin(owner, request);
    await jobs.acknowledgePart(owner, first.jobId, { partNumber: 1, etag: "etag", size: 100 });
    r2.completeMultipartUpload.mockRejectedValueOnce(new Error("connection lost after storage completed"));
    await expect(jobs.completeArchive(owner, first.jobId)).rejects.toMatchObject({ code: "unavailable" });
    r2.headObject.mockResolvedValue({ exists: true });
    const restarted = new LocalChatImportJobs({ repository: chats, storage: r2, runtimeOwnerId: owner.ownerId, now: () => new Date(Date.now() + 120_000) });
    await restarted.recoverPending();
    expect(await restarted.get(owner, first.jobId)).toMatchObject({ status: "uploaded" });
    expect(r2.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });
  it("recovers an allocated upload whose durable receipt was lost during a crash", async () => {
    const first = await jobs.begin(owner, request);
    await chats.kysely.updateTable("local_chat_import_jobs").set({ status: "creating", upload_id: null, lease_expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", first.jobId).execute();
    const key = r2.createMultipartUpload.mock.calls[0]![0];
    r2.listMultipartUploads.mockResolvedValue([{ key, uploadId: "multipart-original" }]);
    await jobs.recoverPending();
    expect(await jobs.get(owner, first.jobId)).toMatchObject({ status: "uploading" });
    expect(r2.createMultipartUpload).toHaveBeenCalledTimes(1);
  });
  it("cancels an upload privately and retains cleanup intent after storage failure", async () => {
    const first = await jobs.begin(owner, request);
    r2.deleteObject.mockRejectedValueOnce(new Error("temporary storage failure"));
    expect(await jobs.cancel(owner, first.jobId)).toMatchObject({ status: "cancelled", cleanupPending: true });
    await jobs.expire();
    expect(await jobs.get(owner, first.jobId)).toMatchObject({ status: "cancelled", cleanupPending: false });
    expect((await chats.list(owner, { limit: 10 })).items).toEqual([]);
  });
  it("restores upload repair after definitive stale receipts without stranding the job", async () => {
    const first = await jobs.begin(owner, request);
    await jobs.acknowledgePart(owner, first.jobId, { partNumber: 1, etag: "old", size: 100 });
    r2.completeMultipartUpload.mockRejectedValueOnce(Object.assign(new Error("stale receipt"), { name: "InvalidPart" }));
    await expect(jobs.completeArchive(owner, first.jobId)).rejects.toMatchObject({ code: "incomplete" });
    expect(await jobs.get(owner, first.jobId)).toMatchObject({ status: "uploading", parts: [] });
    await jobs.acknowledgePart(owner, first.jobId, { partNumber: 1, etag: "new", size: 100 });
    expect(await jobs.completeArchive(owner, first.jobId)).toMatchObject({ status: "uploaded" });
    expect(r2.completeMultipartUpload.mock.calls.at(-1)?.[2]).toEqual([{ partNumber: 1, etag: "new" }]);
  });

});
