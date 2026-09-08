import { expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { WSEvents } from "hono/ws";
import { registerCanonicalChatEventWebSocketRoute } from "../../packages/gateway/src/chat/event-websocket-route.js";

it("keeps legacy ping/detach and metadata frames without opting into content", async () => {
  let handlers!: WSEvents;
  const touch = vi.fn();
  const onClose = vi.fn();
  const open = vi.fn(async (input) => {
    input.sink.send({ type: "chat.stream.attached" });
    return { touch, onClose };
  });
  const app = new Hono();
  registerCanonicalChatEventWebSocketRoute({ app, stream: { open },
    getPrincipal: () => ({ userId: "owner_a", source: "jwt" }),
    upgradeWebSocket: ((factory: (c: unknown) => WSEvents) => (c: unknown) => {
      handlers = factory(c); return new Response();
    }) as never,
  });
  await app.request("/ws/chats/events?cursor=7");
  const ws = { send: vi.fn(), close: vi.fn(), raw: { bufferedAmount: 0 } };
  handlers.onOpen?.({} as never, ws as never);
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0]).toMatchObject({ cursor: 7, principal: { userId: "owner_a" } });
  expect(open.mock.calls[0]?.[0]).not.toHaveProperty("content");
  handlers.onMessage?.({ data: '{"type":"ping"}' } as never, ws as never);
  expect(ws.send).toHaveBeenLastCalledWith('{"type":"pong"}');
  expect(touch).toHaveBeenCalledOnce();
  handlers.onMessage?.({ data: '{"type":"detach"}' } as never, ws as never);
  expect(onClose).toHaveBeenCalledOnce();
  expect(ws.close).toHaveBeenCalledOnce();
});
