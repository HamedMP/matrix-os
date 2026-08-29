import { afterEach, describe, expect, it, vi } from "vitest";
import * as canonicalChatClientModule from "../../desktop/src/renderer/src/lib/canonical-chat-client";

type CanonicalChatInvalidation =
  | { type: "chat.changed"; chatId: string; cursor: number }
  | { type: "chat.full_refresh"; cursor?: number };

type DesktopCanonicalChatWebSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

type CanonicalChatEventSource = {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): { dispose(): void };
  start(): Promise<void>;
  dispose(): void;
  activeConsumerCount(): number;
};

type CreateCanonicalChatEventSource = (options: {
  gatewayOrigin: string;
  fetchWebSocketToken(): Promise<string>;
  createWebSocket(url: string): DesktopCanonicalChatWebSocket;
  maxConsumers?: number;
  maxReconnectDelayMs?: number;
  setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}) => CanonicalChatEventSource;

const createCanonicalChatEventSource = (
  canonicalChatClientModule as unknown as {
    createCanonicalChatEventSource?: CreateCanonicalChatEventSource;
  }
).createCanonicalChatEventSource;

class FakeChatWebSocket implements DesktopCanonicalChatWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function createSource(options: Parameters<CreateCanonicalChatEventSource>[0]): CanonicalChatEventSource {
  expect(
    createCanonicalChatEventSource,
    "Desktop must expose one shared canonical Chat invalidation source",
  ).toBeTypeOf("function");
  return createCanonicalChatEventSource!(options);
}

describe("shared Desktop canonical Chat event source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one authenticated owner stream across rail and selected-Chat consumers", async () => {
    const sockets: FakeChatWebSocket[] = [];
    const fetchWebSocketToken = vi.fn(async () => "signed-ws-token");
    const source = createSource({
      gatewayOrigin: "https://runtime.test",
      fetchWebSocketToken,
      createWebSocket: (url) => {
        const ws = new FakeChatWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    const railEvents: CanonicalChatInvalidation[] = [];
    const selectedEvents: CanonicalChatInvalidation[] = [];
    source.subscribe((event) => railEvents.push(event));
    source.subscribe((event) => selectedEvents.push(event));

    await source.start();
    sockets[0]!.emit({ type: "chat.stream.attached" });
    sockets[0]!.emit({ type: "chat.replay.end", nextCursor: 7 });
    sockets[0]!.emit({
      type: "chat.event",
      event: {
        cursor: 8,
        chatId: "chat_background",
        revision: 3,
        eventType: "run.completed",
        createdAt: "2026-08-29T00:00:08.000Z",
      },
    });

    expect(fetchWebSocketToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://runtime.test/ws/chats/events?token=signed-ws-token");
    expect(railEvents).toEqual([
      { type: "chat.full_refresh", cursor: 7 },
      { type: "chat.changed", chatId: "chat_background", cursor: 8 },
    ]);
    expect(selectedEvents).toEqual(railEvents);
  });

  it("resumes the exact last cursor after bounded reconnect and clears timers on dispose", async () => {
    const sockets: FakeChatWebSocket[] = [];
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const source = createSource({
      gatewayOrigin: "https://runtime.test",
      fetchWebSocketToken: vi.fn(async () => "ws-token"),
      createWebSocket: (url) => {
        const ws = new FakeChatWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      maxReconnectDelayMs: 1_000,
      setTimeoutFn: (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: (timer) => {
        (timer as { cleared: boolean }).cleared = true;
      },
    });
    source.subscribe(() => undefined);
    await source.start();
    sockets[0]!.emit({ type: "chat.replay.end", nextCursor: 41 });
    sockets[0]!.emitClose();

    expect(timers[0]?.delay).toBeGreaterThan(0);
    expect(timers[0]?.delay).toBeLessThanOrEqual(1_000);
    timers[0]!.callback();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1]?.url).toBe("wss://runtime.test/ws/chats/events?token=ws-token&cursor=41");

    sockets[1]!.emitClose();
    source.dispose();
    expect(timers.at(-1)?.cleared).toBe(true);
    expect(sockets[1]?.closed).toBe(true);
  });

  it("refreshes each unseen cursor once, including a lower cursor committed after a higher one", async () => {
    const sockets: FakeChatWebSocket[] = [];
    const invalidations: CanonicalChatInvalidation[] = [];
    const source = createSource({
      gatewayOrigin: "https://runtime.test",
      fetchWebSocketToken: vi.fn(async () => "ws-token"),
      createWebSocket: (url) => {
        const ws = new FakeChatWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    source.subscribe((event) => invalidations.push(event));
    await source.start();
    sockets[0]!.emit({ type: "chat.replay.end", nextCursor: 3 });
    for (const cursor of [5, 4, 5, 4]) {
      sockets[0]!.emit({
        type: "chat.event",
        event: {
          cursor,
          chatId: `chat_${cursor}`,
          revision: cursor,
          eventType: "chat.updated",
          createdAt: "2026-08-29T00:00:00.000Z",
        },
      });
    }

    expect(invalidations).toEqual([
      { type: "chat.full_refresh", cursor: 3 },
      { type: "chat.changed", chatId: "chat_5", cursor: 5 },
      { type: "chat.changed", chatId: "chat_4", cursor: 4 },
    ]);
  });

  it("turns a replay gap into one canonical full refresh and rejects unsafe frames", async () => {
    const sockets: FakeChatWebSocket[] = [];
    const invalidations: CanonicalChatInvalidation[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = createSource({
      gatewayOrigin: "https://runtime.test",
      fetchWebSocketToken: vi.fn(async () => "ws-token"),
      createWebSocket: (url) => {
        const ws = new FakeChatWebSocket(url);
        sockets.push(ws);
        return ws;
      },
    });
    source.subscribe((event) => invalidations.push(event));
    await source.start();
    sockets[0]!.emit({ type: "chat.replay.gap", reason: "cursor_unavailable" });
    sockets[0]!.emit({ type: "chat.replay.end", nextCursor: 12 });
    sockets[0]!.emit({
      type: "chat.event",
      event: {
        cursor: 13,
        chatId: "chat_unsafe",
        revision: 1,
        eventType: "run.completed",
        createdAt: "2026-08-29T00:00:00.000Z",
        transcript: "must not reach consumers",
      },
    });

    expect(invalidations).toEqual([{ type: "chat.full_refresh", cursor: 12 }]);
    expect(warn).toHaveBeenCalled();
  });

  it("bounds shared consumers and fails safely when credentials are unavailable", async () => {
    const sockets: FakeChatWebSocket[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = createSource({
      gatewayOrigin: "https://runtime.test",
      fetchWebSocketToken: vi.fn(async () => {
        throw new Error("credential secret must stay private");
      }),
      createWebSocket: (url) => {
        const ws = new FakeChatWebSocket(url);
        sockets.push(ws);
        return ws;
      },
      maxConsumers: 2,
    });
    const first = source.subscribe(() => undefined);
    source.subscribe(() => undefined);
    expect(() => source.subscribe(() => undefined)).toThrow(/consumer|subscriber|limit/i);

    await expect(source.start()).resolves.toBeUndefined();
    expect(sockets).toEqual([]);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("credential secret must stay private");
    expect(source.activeConsumerCount()).toBe(2);
    first.dispose();
    expect(source.activeConsumerCount()).toBe(1);
    source.dispose();
    expect(source.activeConsumerCount()).toBe(0);
  });
});
