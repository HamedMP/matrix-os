import { expect, it } from "vitest";
import { CanonicalChatStreamServerFrameSchema } from "@matrix-os/contracts";
import { Hono } from "hono";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import type { ChatOutboxSink } from "../../packages/gateway/src/chat/outbox-delivery.js";

it("negotiates content explicitly while preserving the strict old SSE wire format", async () => {
  let publish!: ChatOutboxSink;
  const stream = createCanonicalChatEventStream({ repository: {
    registerOutboxSink(sink) { publish = sink; return { dispose() {} }; },
    async replayOutboxWindow() { return { events: [], gap: false }; },
  } });
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, stream, getPrincipal: () => ({ userId: "owner_a", source: "jwt" }) });
  const old = (await app.request("/api/chats/events", { headers: { accept: "text/event-stream" } })).body!.getReader();
  const modern = (await app.request("/api/chats/events", { headers: {
    accept: "text/event-stream", "x-matrix-chat-protocol": "2",
  } })).body!.getReader();
  try {
    for (const reader of [old, modern]) { await reader.read(); await reader.read(); }
    const event = { cursor: 1, chatId: "chat_test", revision: 0, eventType: "chat.created" as const,
      createdAt: "2026-09-06T00:00:00.000Z", payload: { streamContent: { record: { chat: {
        id: "chat_test", ownerScope: { type: "personal", ownerId: "owner_a" }, title: "Test",
        lifecycle: "active", attention: "none", revision: 0, messageCount: 0,
        createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
      } } } } };
    publish({ owner: { type: "personal", ownerId: "owner_a" }, event });
    const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes).split("data: ")[1]!.trim());
    const legacyFrame = decode((await old.read()).value!);
    expect(CanonicalChatStreamServerFrameSchema.parse(legacyFrame).type).toBe("chat.event");
    expect(JSON.stringify(legacyFrame)).not.toContain("streamContent");
    expect(decode((await modern.read()).value!)).toMatchObject({ type: "chat.content", content: event.payload.streamContent });
    publish({ owner: { type: "personal", ownerId: "owner_a" }, event: { ...event, cursor: 2, payload: {
      streamContent: { record: { chat: { ...event.payload.streamContent.record.chat,
        ownerScope: { type: "personal", ownerId: "owner_b" },
      } } },
    } } });
    const isolated = decode((await modern.read()).value!);
    expect(isolated.type).toBe("chat.event");
    expect(JSON.stringify(isolated)).not.toContain("owner_b");
    const invalid = await app.request("/api/chats/events", { headers: { accept: "text/event-stream", "x-matrix-chat-protocol": "999" } });
    expect(invalid.status).toBe(400);
  } finally { await old.cancel(); await modern.cancel(); stream.shutdown(); }
});
