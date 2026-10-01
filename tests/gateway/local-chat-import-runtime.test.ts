import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { registerLocalChatImports } from "../../packages/gateway/src/chat/local-import/runtime.js";
import type { R2Client } from "../../packages/gateway/src/sync/r2-client.js";
const ownerId = "synthetic_runtime_owner";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const encode = new TextEncoder();
describe("local import gateway runtime wiring", () => {
  let repository: ChatRepository | undefined; let lifecycle: { close(): Promise<void> } | undefined;
  afterEach(async () => { await lifecycle?.close(); await repository?.kysely.destroy(); vi.unstubAllGlobals(); });
  it("uploads the original, publishes private history in the worker, downloads full content, and denies foreign reads", async () => {
    const pg = await KyselyPGlite.create(); repository = new ChatRepository(pg.dialect); await repository.bootstrap();
    const fullText = "Synthetic output ".repeat(1000);
    const raw = encode.encode([
      { type: "session_meta", payload: { id: sourceId } },
      { type: "response_item", payload: { type: "message", id: "input", role: "user", content: [{ type: "input_text", text: "Synthetic input" }] } },
      { type: "response_item", payload: { type: "message", id: "answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: fullText }] } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const objects = new Map<string, Uint8Array>(); // Synthetic fixture: at most the one original and one full-text asset.
    let originalKey = "";
    const storage = {
      createMultipartUpload: vi.fn(async (key: string) => { originalKey = key; return "synthetic_upload"; }),
      getPresignedPartUrl: vi.fn(async () => "https://storage.example.test/part"),
      completeMultipartUpload: vi.fn(async () => { objects.set(originalKey, raw); return { etag: "complete" }; }),
      headObject: vi.fn(async (key: string) => ({ exists: objects.has(key) })),
      abortMultipartUpload: vi.fn(async () => {}), listMultipartUploads: vi.fn(async () => []),
      getPresignedGetUrl: vi.fn(async (key: string) => `https://storage.example.test/object/${encodeURIComponent(key)}`),
      putObject: vi.fn(async (key: string, bytes: Uint8Array) => { if (objects.size >= 8) throw new Error("Synthetic fixture cap"); objects.set(key, bytes); return { etag: "asset" }; }),
      deleteObject: vi.fn(async (key: string) => { objects.delete(key); }),
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = new URL(String(url)); const key = decodeURIComponent(value.pathname.slice("/object/".length));
      const bytes = objects.get(key); return bytes ? new Response(bytes as BodyInit) : new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono(); lifecycle = registerLocalChatImports({ app, repository, storage: storage as unknown as R2Client, runtimeOwnerId: ownerId,
      getPrincipal: c => ({ userId: c.req.header("test-owner") ?? ownerId, source: "jwt" }) });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const begin = await post("/api/chats/imports/local", { harness: "codex", sourceId, sourceHash: createHash("sha256").update(raw).digest("hex"), rawSize: raw.byteLength, title: "Synthetic runtime import" });
    expect(begin.status).toBe(201); const job = await begin.json();
    const signed = await post(`/api/chats/imports/local/${job.jobId}/parts`, { partNumbers: [1] }); expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ parts: [{ partNumber: 1, size: raw.byteLength, url: "https://storage.example.test/part" }] });
    expect((await post(`/api/chats/imports/local/${job.jobId}/parts/ack`, { partNumber: 1, etag: "part", size: raw.byteLength })).status).toBe(200);
    expect((await post(`/api/chats/imports/local/${job.jobId}/complete`, {})).status).toBe(202);
    let chatId = "";
    await vi.waitFor(async () => { const state = await (await app.request(`/api/chats/imports/local/${job.jobId}`)).json();
      expect(state.status).toBe("published"); chatId = state.chatId; }, { timeout: 10_000, interval: 25 });
    const exported = await repository.exportChat({ type: "personal", ownerId }, chatId);
    expect(exported?.messages).toHaveLength(2); expect(exported?.turns).toHaveLength(1); expect(exported?.runs).toHaveLength(0);
    const asset = exported!.messages.flatMap(message => message.parts).find(part => part.type === "import_reference");
    expect(asset?.type).toBe("import_reference"); if (asset?.type !== "import_reference") throw new Error("Missing synthetic asset");
    const downloadPath = `/api/chats/${chatId}/imports/assets/${asset.assetId}/content`;
    expect(await (await app.request(downloadPath)).text()).toBe(fullText);
    expect((await app.request(downloadPath, { headers: { "test-owner": "foreign" } })).status).toBe(404);
    expect((await app.request(`/api/chats/imports/local/${job.jobId}/archive`, { headers: { "test-owner": "foreign" } })).status).toBe(404);
    expect((await app.request(`/api/chats/imports/local/${job.jobId}/archive`)).status).toBe(200);
    await lifecycle.close(); lifecycle = undefined;
    // Closing the imported worker never destroys the gateway-owned DB or primary store.
    expect((await repository.list({ type: "personal", ownerId }, { limit: 10 })).items).toHaveLength(1);
    expect(storage.deleteObject).not.toHaveBeenCalled(); expect(objects.get(originalKey)).toEqual(raw);
  });
  it("mounts authenticated unavailable routes when owner dependencies are absent", async () => {
    const app = new Hono(); lifecycle = registerLocalChatImports({ app, repository: null, getPrincipal: () => ({ userId: ownerId, source: "jwt" }) });
    const response = await app.request("/api/chats/imports/local", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
  });
});
