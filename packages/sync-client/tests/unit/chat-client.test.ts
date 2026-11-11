import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatClient, readAllChat, renderChatMarkdown, writeChatExport } from "../../src/cli/chat-client.js";
import { watchChat } from "../../src/cli/chat-watch.js";

const id = "chat_test";
const time = "2026-10-18T00:00:00.000Z";
function detail(sequences: number[] = [1], nextCursor?: string) {
  return { record: { chat: { id, ownerScope: { type: "personal", ownerId: "owner_test" }, title: "Test", lifecycle: "active", attention: "none", revision: 3,
    messageCount: 3, currentSelection: { instanceId: "claude_code_default", model: "default" }, createdAt: time, updatedAt: time } },
    messages: sequences.map(seq => ({ id: `msg_${seq}`, chatId: id, seq, role: "user", state: "committed", parts: [{ type: "text", text: `Message ${seq}` }], createdAt: time })),
    turns: [], runs: [], activities: [], ...(nextCursor ? { nextCursor } : {}) };
}
function client(fetcher: typeof fetch) { return createChatClient({ gatewayUrl: "https://app.matrix-os.com/vm/neo?runtime=review", token: "private-token", fetch: fetcher }); }
function watchClient(fetcher: typeof fetch) { return { ...client(fetcher), read: vi.fn().mockResolvedValue(detail()) }; }

describe("Chat ID client", () => {
  it("preserves selected runtime, authenticates and validates canonical details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(detail()));
    await expect(client(fetcher).read(id)).resolves.toMatchObject(detail());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/vm/neo/api/chats/chat_test?runtime=review&");
    expect(init).toMatchObject({ redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer private-token" }), signal: expect.any(AbortSignal) });
  });
  it.each(["../chats", "chat_a?token=bad", "chat_a/b", ""])("rejects invalid IDs before network: %s", async invalid => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).read(invalid)).rejects.toMatchObject({ code: "chat_invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a response from another Chat", async () => {
    const data = detail(); data.record.chat.id = "chat_other";
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(Response.json(data))).read(id)).rejects.toMatchObject({ code: "chat_invalid_response" });
  });
  it.each([401,403,404,409,500])("returns safe errors for HTTP %s", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("postgres://secret@host/db", { status }));
    await expect(client(fetcher).read(id)).rejects.not.toThrow(/postgres|secret|host/);
  });
  it("rejects oversized declared responses", async () => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024 + 1) } }))).read(id)).rejects.toMatchObject({ code: "chat_limit" });
  });
  it("sends one exact revision-guarded payload and preserves request ID on uncertain failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(detail())).mockRejectedValueOnce(new TypeError("private address"));
    await expect(client(fetcher).send(id, "Hello", { requestId: "req_retry" })).rejects.toMatchObject({ code: "chat_send_uncertain", requestId: "req_retry" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual({ clientRequestId: "req_retry", baseRevision: 3, parts: [{ type: "text", text: "Hello" }],
      selection: { instanceId: "claude_code_default", model: "default" }, interactionMode: "default", permissionMode: "supervised" });
  });
  it("does not submit empty messages or silently choose a model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...detail(), record: { chat: { ...detail().record.chat, currentSelection: undefined } } }));
    await expect(client(fetcher).send(id," ")).rejects.toMatchObject({ code: "chat_invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client(fetcher).send(id,"Hello")).rejects.toMatchObject({ code: "chat_selection_required" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized human text before making a request", async () => {
    const fetcher=vi.fn<typeof fetch>();
    await expect(client(fetcher).send(id,"x".repeat(24001))).rejects.toMatchObject({code:"chat_invalid_input"});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("exports every page in chronological order", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(detail([3],"chatcur_older"))).mockResolvedValueOnce(Response.json(detail([1,2])));
    const data = await readAllChat(client(fetcher), id);
    expect(data.messages.map(m=>m.seq)).toEqual([1,2,3]);
    expect(String(fetcher.mock.calls[1]![0])).toContain("cursor=chatcur_older");
    expect(renderChatMarkdown(data)).toContain("Message 1");
  });
  it("rejects repeated or discontinuous pages and changing revisions", async () => {
    for (const older of [detail([1],"chatcur_older"), detail([1]), { ...detail([1,2]), record: { chat: { ...detail().record.chat, revision: 4 } } }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(detail([3],"chatcur_older"))).mockResolvedValueOnce(Response.json(older));
      await expect(readAllChat(client(fetcher),id)).rejects.toMatchObject({ code: expect.stringMatching(/^chat_(invalid_response|changed)$/) });
    }
  });
  it("rejects an export with silently missing earlier messages", async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json(detail([3])));
    await expect(readAllChat(client(fetcher),id)).rejects.toMatchObject({code:"chat_invalid_response"});
  });
  it("writes a private export exclusively and preserves existing files", async () => {
    const dir=await mkdtemp(join(tmpdir(),"chat-cli-test-"));
    try {
      const path=join(dir,"chat.json"); await writeChatExport(path,"saved");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(writeChatExport(path,"overwrite")).rejects.toMatchObject({ code:"chat_file_exists" });
      expect(await readFile(path,"utf8")).toBe("saved");
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});

describe("Chat watch", () => {
  it("detaches quietly when cancelled during the initial Chat check", async () => {
    const stop = new AbortController(); const fetcher = vi.fn<typeof fetch>();
    const selected = watchClient(fetcher);
    selected.read.mockImplementation(async()=>{ stop.abort(); throw new DOMException("aborted","AbortError"); });
    await expect(watchChat(selected,id,{signal:stop.signal,onFrame:()=>{}})).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not open the global stream for a missing Chat", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(watchChat(client(fetcher), id, { signal: new AbortController().signal, onFrame: () => {} }))
      .rejects.toMatchObject({ code: "chat_not_found" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain(`/api/chats/${id}?`);
  });
  it("delivers unseen lower cursors once even after another Chat's higher cursor", async () => {
    const stop = new AbortController(); const received: number[] = [];
    const text = [[5,"chat_other"],[4,id],[4,id],[3,id]].map(([cursor,chatId]) =>
      `data: ${JSON.stringify({ type:"chat.event",event:{cursor,chatId,revision:4,eventType:"chat.updated",createdAt:time} })}\n\n`).join("");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text,{headers:{"content-type":"text/event-stream"}}));
    await watchChat(watchClient(fetcher),id,{signal:stop.signal,retryDelayMs:1,onFrame:frame=>{
      if(frame.type==="chat.event") { received.push(frame.event.cursor); if(received.length===2) stop.abort(); }
    }});
    expect(received).toEqual([4,3]);
  });
  it("keeps reconnecting after healthy quiet connections time out", async () => {
    const stop = new AbortController(); let now = 0; let calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (++calls === 7) { stop.abort(); throw new DOMException("aborted", "AbortError"); }
      return new Response(new ReadableStream({ pull(controller) {
        now += 300_001;
        controller.error(new DOMException("request timed out", "TimeoutError"));
      } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      await watchChat(watchClient(fetcher), id, { signal: stop.signal, onFrame: () => {}, retryDelayMs: 1 });
      expect(calls).toBe(7);
    } finally { clock.mockRestore(); }
  });
  it("bounds repeated connections that fail immediately", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection failed"));
    await expect(watchChat(watchClient(fetcher), id, {
      signal: new AbortController().signal, onFrame: () => {}, retryDelayMs: 1,
    })).rejects.toMatchObject({ code: "chat_watch_disconnected" });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("handles split SSE frames, filters other Chats and preserves a resume cursor", async () => {
    const stop=new AbortController(); const frames: unknown[]=[];
    const events=[{type:"chat.event",event:{cursor:8,chatId:"chat_other",revision:4,eventType:"chat.updated",createdAt:time}},
      {type:"chat.event",event:{cursor:9,chatId:id,revision:4,eventType:"chat.updated",createdAt:time}}];
    const text=events.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("");
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(new ReadableStream({ start(c){c.enqueue(new TextEncoder().encode(text.slice(0,15)));c.enqueue(new TextEncoder().encode(text.slice(15)));c.close();} }),{headers:{"content-type":"text/event-stream"}}));
    await watchChat(watchClient(fetcher), id, {signal:stop.signal,onFrame:frame=>{frames.push(frame);stop.abort();}});
    expect(frames).toEqual([events[1]]);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({Accept:"text/event-stream"});
  });
  it("resumes after EOF and stops on cancellation", async () => {
    const stop=new AbortController(); let calls=0;
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      calls++; if(calls===2){expect(init?.headers).toMatchObject({"Last-Event-ID":"7"});stop.abort();throw new DOMException("aborted","AbortError");}
      return new Response(`data: ${JSON.stringify({type:"chat.replay.end",nextCursor:7})}\n\n`,{headers:{"content-type":"text/event-stream"}});
    });
    await watchChat(watchClient(fetcher),id,{signal:stop.signal,onFrame:()=>{},retryDelayMs:1});
    expect(calls).toBe(2);
  });
  it("parses CRLF even when a chunk ends between CR and LF", async () => {
    const stop=new AbortController();
    const frame={type:"chat.event",event:{cursor:1,chatId:id,revision:4,eventType:"chat.updated",createdAt:time}};
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\r`));
      c.enqueue(new TextEncoder().encode("\n\r"));c.enqueue(new TextEncoder().encode("\n"));c.close();
    }}),{headers:{"content-type":"text/event-stream"}}));
    const onFrame=vi.fn(()=>stop.abort());
    await watchChat(watchClient(fetcher),id,{signal:stop.signal,onFrame,retryDelayMs:1});
    expect(onFrame).toHaveBeenCalledWith(frame);
  });
  it("stops without reconnecting when its output consumer fails",async()=>{
    const frame={type:"chat.event",event:{cursor:1,chatId:id,revision:4,eventType:"chat.updated",createdAt:time}};
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(`data: ${JSON.stringify(frame)}\n\n`,{headers:{"content-type":"text/event-stream"}}));
    await expect(watchChat(watchClient(fetcher),id,{signal:new AbortController().signal,onFrame:()=>{throw Error("broken pipe");},retryDelayMs:1})).rejects.toMatchObject({code:"chat_output_failed"});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
