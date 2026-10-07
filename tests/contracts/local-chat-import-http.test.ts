import { describe, expect, it, vi } from "vitest";
import { createLocalChatHttpTransport } from "../../packages/contracts/src/local-chat-import/http.js";
describe("local Chat upload HTTP authority", () => {
  it("sends authentication only to Matrix and uses a bounded original-byte storage PUT", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, options: RequestInit) => options.method === "PUT"
      ? new Response(null, { headers: { etag: '"synthetic-receipt"' } }) : new Response('{}', { headers: { "content-type": "application/json" } }));
    const transport = createLocalChatHttpTransport({ baseUrl: "https://matrix.example.test", headers: () => ({ authorization: "Bearer synthetic-token" }), runtimeSlot: "synthetic-slot", fetchImpl: fetchImpl as unknown as typeof fetch });
    const signal = new AbortController().signal;
    await transport.request("/api/chats/imports/local", { method: "POST", body: { title: "Synthetic" }, signal });
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("runtime")).toBe("synthetic-slot");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer synthetic-token" }), redirect: "error", signal: expect.any(AbortSignal) });
    const bytes = new Uint8Array([1, 2, 3]); expect(await transport.put("https://storage.example.test/part", bytes, signal)).toBe('"synthetic-receipt"');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: bytes, redirect: "error" });
    expect(fetchImpl.mock.calls[1]?.[1].headers).toBeUndefined();
  });
  it("rejects oversized JSON and raw upstream errors with generic typed failures", async () => {
    const signal = new AbortController().signal;
    const transport = createLocalChatHttpTransport({ baseUrl: "https://matrix.example.test", headers: () => ({}),
      fetchImpl: vi.fn(async () => new Response('x'.repeat(300_000))) as unknown as typeof fetch });
    await expect(transport.request("/api/chats/imports/local", { method: "GET", signal })).rejects.toMatchObject({ code: "invalid_response" });
    const failed = createLocalChatHttpTransport({ baseUrl: "https://matrix.example.test", headers: () => ({}),
      fetchImpl: vi.fn(async () => new Response('postgres://private/secret', { status: 503 })) as unknown as typeof fetch });
    await expect(failed.request("/api/chats/imports/local", { method: "GET", signal })).rejects.toMatchObject({ code: "unavailable", message: "Chat import unavailable" });
  });
  it("preserves an explicit computer route instead of falling back to the primary machine",async()=>{
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}}));
    const client=createLocalChatHttpTransport({baseUrl:"https://app.example.test/vm/synthetic/~runtime/work",headers:()=>({}),fetchImpl:fetchImpl as typeof fetch});
    await client.request("/api/chats/imports/local",{method:"POST",body:{},signal:new AbortController().signal});
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://app.example.test/vm/synthetic/~runtime/work/api/chats/imports/local");
  });
  it("cancels the response stream if the native session changes after headers arrive",async()=>{
    const cancelled=vi.fn();let current=true;
    const fetchImpl=vi.fn(async()=>{current=false;return new Response(new ReadableStream({cancel:cancelled}));});
    const client=createLocalChatHttpTransport({baseUrl:"https://app.example.test",headers:()=>({}),fetchImpl:fetchImpl as typeof fetch,assertCurrent:()=>{if(!current)throw new DOMException("Stopped","AbortError");}});
    await expect(client.request("/api/chats/imports/local",{method:"GET",signal:new AbortController().signal})).rejects.toThrow("Stopped");expect(cancelled).toHaveBeenCalled();
  });
});
