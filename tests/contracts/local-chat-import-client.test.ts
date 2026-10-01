import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { uploadLocalChatArchive, LocalChatTransferError } from "../../packages/contracts/src/local-chat-import/client.js";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const jobId = "019eb0ae-9a30-7541-bdb8-db4d17e65147";
const raw = new TextEncoder().encode("Synthetic original bytes\n");
const sourceHash = createHash("sha256").update(raw).digest("hex");
function fixture(options: { published?: boolean; changed?: boolean; badUrl?: boolean; acknowledged?: boolean } = {}) {
  let published = options.published ?? false;
  const state = () => ({ jobId, status: published ? "published" : "uploading", partSize: 64 * 1024 * 1024, totalParts: 1,
    expiresAt: "2026-10-01T00:00:00Z", cleanupPending: false, parts: options.acknowledged ? [{ partNumber: 1, etag: "old", size: raw.length }] : [],
    ...(published ? { chatId: "chat_synthetic_import" } : {}) });
  const request = vi.fn(async (path: string, input: { method: string; body?: unknown }) => {
    if (path.endsWith("/parts")) return { parts: [{ partNumber: 1, size: raw.length, url: options.badUrl ? "http://localhost/private" : "https://storage.example.test/part", expiresAt: "2026-10-01T00:00:00Z" }] };
    if (path.endsWith("/complete")) { published = true; return state(); }
    if (path === "/api/chats/chat_synthetic_import?limit=1") return { record: { chat: { id: "chat_synthetic_import", messageCount: 2 } } };
    return state();
  });
  const put = vi.fn(async () => "new-etag");
  const source = { read: vi.fn(async (offset: number, length: number) => options.changed ? new Uint8Array(length) : raw.slice(offset, offset + length)),
    createHash: () => { const hash = createHash("sha256"); return { update: (bytes: Uint8Array) => { hash.update(bytes); }, digest: () => hash.digest("hex") }; } };
  const payload = { harness: "codex" as const, sourceId, sourceHash, rawSize: raw.length, title: "Synthetic import" };
  return { request, put, source, payload };
}
describe("shared original-byte Chat upload client", () => {
  it("uploads original bytes, acknowledges the exact receipt, waits for publication, and verifies canonical read-back", async () => {
    const x = fixture(); const result = await uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put });
    expect(result).toEqual({ chatId: "chat_synthetic_import", messageCount: 2, jobId });
    expect(x.put).toHaveBeenCalledWith("https://storage.example.test/part", raw, expect.any(AbortSignal));
    expect(x.request.mock.calls.find(([path]) => path.endsWith("/parts/ack"))?.[1]).toMatchObject({ method: "POST", body: { partNumber: 1, etag: "new-etag", size: raw.length } });
    expect(x.request.mock.calls.find(([path]) => path === "/api/chats/imports/local")?.[1]).toMatchObject({ body: x.payload });
    expect(JSON.stringify(x.request.mock.calls)).not.toContain("messages");
  });
  it("resumes acknowledged parts but still hashes captured source bytes before completion", async () => {
    const x = fixture({ acknowledged: true }); await uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put });
    expect(x.put).not.toHaveBeenCalled(); expect(x.source.read).toHaveBeenCalledTimes(1);
  });
  it("never seals or publishes bytes that changed after preview", async () => {
    const x = fixture({ changed: true }); await expect(uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put })).rejects.toMatchObject({ code: "source_changed" });
    expect(x.request.mock.calls.some(([path]) => path.endsWith("/complete"))).toBe(false);
  });
  it("rejects unsigned storage destinations and preserves resumable state when cancelled", async () => {
    const x = fixture({ badUrl: true }); await expect(uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put })).rejects.toMatchObject({ code: "invalid_response" });
    expect(x.put).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    const y = fixture(); await expect(uploadLocalChatArchive(y.payload, y.source, { request: y.request, put: y.put }, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(y.request).not.toHaveBeenCalled();
  });
  it("returns an already published snapshot without uploading or reading the local source", async () => {
    const x = fixture({ published: true }); await uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put });
    expect(x.put).not.toHaveBeenCalled(); expect(x.source.read).not.toHaveBeenCalled();
  });
  it("rejects a receipt response for another job before completing the selected source", async () => {
    const x = fixture(); const original = x.request.getMockImplementation()!;
    x.request.mockImplementation(async (path, input) => {
      const value = await original(path, input);
      return path.endsWith("/parts/ack") ? { ...value, jobId: "019eb0ae-9a30-7541-bdb8-db4d17e65148" } : value;
    });
    await expect(uploadLocalChatArchive(x.payload, x.source, { request: x.request, put: x.put })).rejects.toMatchObject({ code: "invalid_response" });
    expect(x.request.mock.calls.some(([path]) => path.endsWith("/complete"))).toBe(false);
  });

  it("recovers a completion response lost after the server publishes the archive",async()=>{
    const x=fixture();const original=x.request.getMockImplementation()!;
    x.request.mockImplementation(async(path,input)=>{const value=await original(path,input);if(path.endsWith("/complete"))throw new LocalChatTransferError("unavailable");return value;});
    expect(await uploadLocalChatArchive(x.payload,x.source,{request:x.request,put:x.put})).toMatchObject({chatId:"chat_synthetic_import",jobId});
  });
});
