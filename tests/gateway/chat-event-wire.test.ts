import { Hono } from "hono";
import type { WSEvents } from "hono/ws";
import { expect, it, vi } from "vitest";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route.js";
import { registerCanonicalChatEventWebSocketRoute } from "../../packages/gateway/src/chat/event-websocket-route.js";

const botEvent: CanonicalChatTransportFrame = {
  type: "chat.event",
  event: { cursor: 3, chatId: "chat_bot", revision: 2, eventType: "interaction.requested", createdAt: "2026-09-27T12:00:00.000Z" },
};

async function httpEventTypes(query: string): Promise<string[]> {
  const app = new Hono();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }),
    stream: { open: async ({ sink }) => {
      sink.send(botEvent);
      return { onClose() {}, touch() {} };
    } }, setIntervalFn: vi.fn(() => 1), clearIntervalFn: vi.fn() });
  const response = await app.request(`/api/chats/events${query}`, { headers: { accept: "text/event-stream" } });
  const reader = response.body!.getReader();
  try {
    const text = new TextDecoder().decode((await reader.read()).value);
    return text.split("data: ").slice(1).map((chunk) => JSON.parse(chunk.trim()).event.eventType as string);
  } finally {
    await reader.cancel();
  }
}

it("projects bot event types to chat.updated for SSE clients on event wire v0", async () => {
  expect(await httpEventTypes("")).toEqual(["chat.updated"]);
  expect(await httpEventTypes("?eventVersion=0")).toEqual(["chat.updated"]);
  expect(await httpEventTypes("?eventVersion=1")).toEqual(["interaction.requested"]);
});

it("rejects unsupported event wire versions before opening the stream", async () => {
  const app = new Hono();
  const open = vi.fn();
  registerCanonicalChatEventHttpRoute({ app, getPrincipal: () => ({ userId: "owner", source: "jwt" }), stream: { open } });
  expect((await app.request("/api/chats/events?eventVersion=2", { headers: { accept: "text/event-stream" } })).status).toBe(400);
  expect(open).not.toHaveBeenCalled();
});

it.each([["", "chat.updated"], ["&eventVersion=1", "interaction.requested"]])(
  "projects bot event types for WebSocket clients (%s)",
  async (query, expected) => {
    let handlers!: WSEvents;
    const open = vi.fn(async (input: { sink: { send(frame: CanonicalChatTransportFrame): boolean } }) => {
      input.sink.send(botEvent);
      return { touch() {}, onClose() {} };
    });
    const app = new Hono();
    registerCanonicalChatEventWebSocketRoute({ app, stream: { open },
      getPrincipal: () => ({ userId: "owner", source: "jwt" }),
      upgradeWebSocket: ((factory: (c: unknown) => WSEvents) => (c: unknown) => {
        handlers = factory(c); return new Response();
      }) as never,
    });
    await app.request(`/ws/chats/events?cursor=1${query}`);
    const ws = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
    handlers.onOpen?.({} as never, ws as never);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string).event.eventType).toBe(expected);
  },
);
