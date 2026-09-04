import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCanonicalChatEventSource,
  type CanonicalChatInvalidation,
  type DesktopCanonicalChatWebSocket,
} from "../../desktop/src/renderer/src/lib/canonical-chat-client";

class FakeSocket implements DesktopCanonicalChatWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  emit(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  emitOpen() { this.readyState = 1; this.onopen?.(); }
  emitClose() { this.readyState = 3; this.onclose?.(); }
}

type Timer = { callback: () => void; delay: number; cleared: boolean };
type SourceOptions = Parameters<typeof createCanonicalChatEventSource>[0];

function event(cursor: number, prefix = "chat") {
  return {
    type: "chat.event",
    event: { cursor, chatId: `${prefix}_${cursor}`, revision: cursor, eventType: "chat.updated", createdAt: "2026-08-29T00:00:00.000Z" },
  };
}

function harness(overrides: Partial<SourceOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: Timer[] = [];
  const heartbeatTimers: Timer[] = [];
  const invalidations: CanonicalChatInvalidation[] = [];
  const source = createCanonicalChatEventSource({
    gatewayOrigin: "https://runtime.test",
    fetchWebSocketToken: vi.fn(async () => "ws-token"),
    createWebSocket: (url) => { const ws = new FakeSocket(url); sockets.push(ws); return ws; },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { (timer as Timer).cleared = true; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      heartbeatTimers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { (timer as Timer).cleared = true; },
    ...overrides,
  });
  return { source, sockets, timers, heartbeatTimers, invalidations };
}

async function start(input: ReturnType<typeof harness>) {
  input.source.subscribe((next) => input.invalidations.push(next));
  await input.source.start();
  return input.sockets[0]!;
}

describe("shared Desktop canonical Chat event source", () => {
  afterEach(() => vi.restoreAllMocks());

  it("publishes healthy state only after server attachment and falls back on stream errors", async () => {
    const input = harness();
    const states: string[] = [];
    input.source.subscribeConnectionState(() => states.push(input.source.connectionState()));

    expect(input.source.connectionState()).toBe("idle");
    const ws = await start(input);
    expect(input.source.connectionState()).toBe("connecting");

    ws.emitOpen();
    expect(input.source.connectionState()).toBe("connecting");

    ws.emit({ type: "chat.stream.attached" });
    expect(input.source.connectionState()).toBe("open");

    ws.emit({
      type: "chat.stream.error",
      error: {
        code: "stream_unavailable",
        safeMessage: "Chat stream is temporarily unavailable. Try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
    expect(input.source.connectionState()).toBe("reconnecting");

    ws.emitClose();
    expect(input.source.connectionState()).toBe("reconnecting");

    input.source.dispose();
    expect(input.source.connectionState()).toBe("disposed");
    expect(states).toEqual(["connecting", "open", "reconnecting", "disposed"]);
  });

  it("does not invalidate the rendered Chat after an empty replay", async () => {
    const input = harness();
    const ws = await start(input);

    ws.emit({ type: "chat.stream.attached" });
    ws.emit({ type: "chat.replay.end", nextCursor: 7 });

    expect(input.invalidations).toEqual([]);
  });

  it("reconciles the Chat list once after replaying unseen events", async () => {
    const input = harness();
    const ws = await start(input);

    ws.emit(event(8));
    ws.emit({ type: "chat.replay.end", nextCursor: 8 });

    expect(input.invalidations).toEqual([
      { type: "chat.changed", chatId: "chat_8", cursor: 8, revision: 8, eventType: "chat.updated" },
      { type: "chat.full_refresh", cursor: 8 },
    ]);
  });

  it("keeps an open stream alive with bounded ping/pong and closes a stale socket", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = harness();
    const ws = await start(input);

    ws.emitOpen();
    expect(input.heartbeatTimers).toHaveLength(1);
    expect(input.heartbeatTimers[0]?.delay).toBe(10_000);
    input.heartbeatTimers[0]!.callback();
    expect(ws.sent).toEqual([JSON.stringify({ type: "ping" })]);
    ws.emit({ type: "pong" });
    input.heartbeatTimers[0]!.callback();
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "ping" }),
      JSON.stringify({ type: "ping" }),
    ]);

    input.heartbeatTimers[0]!.callback();
    expect(ws.closed).toBe(true);
    expect(input.heartbeatTimers[0]?.cleared).toBe(true);
    expect(input.timers).toHaveLength(1);

    input.source.dispose();
  });

  it("shares one authenticated owner stream across rail and selected-Chat consumers", async () => {
    const fetchWebSocketToken = vi.fn(async () => "signed-ws-token");
    const input = harness({ fetchWebSocketToken });
    const selected: CanonicalChatInvalidation[] = [];
    input.source.subscribe((next) => selected.push(next));
    const ws = await start(input);
    ws.emit({ type: "chat.stream.attached" });
    ws.emit({ type: "chat.replay.end", nextCursor: 7 });
    ws.emit({ ...event(8, "chat_background"), event: { ...event(8, "chat_background").event, chatId: "chat_background" } });

    expect(fetchWebSocketToken).toHaveBeenCalledOnce();
    expect(input.sockets).toHaveLength(1);
    expect(ws.url).toBe("wss://runtime.test/ws/chats/events?token=signed-ws-token");
    expect(input.invalidations).toEqual([
      {
        type: "chat.changed",
        chatId: "chat_background",
        cursor: 8,
        revision: 8,
        eventType: "chat.updated",
      },
    ]);
    expect(selected).toEqual(input.invalidations);
  });

  it("preserves safe event metadata for targeted Chat refresh decisions", async () => {
    const input = harness();
    const ws = await start(input);
    ws.emit({
      type: "chat.event",
      event: {
        cursor: 9,
        chatId: "chat_streaming",
        revision: 14,
        eventType: "run.message",
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    });

    expect(input.invalidations).toEqual([{
      type: "chat.changed",
      chatId: "chat_streaming",
      cursor: 9,
      revision: 14,
      eventType: "run.message",
    }]);
  });

  it("resumes the exact last cursor after bounded reconnect and clears timers on dispose", async () => {
    const input = harness({ maxReconnectDelayMs: 1_000 });
    const ws = await start(input);
    ws.emitOpen();
    ws.emit({ type: "chat.replay.end", nextCursor: 41 });
    ws.emitClose();
    expect(input.heartbeatTimers[0]?.cleared).toBe(true);
    expect(input.timers[0]?.delay).toBeGreaterThan(0);
    expect(input.timers[0]?.delay).toBeLessThanOrEqual(1_000);
    input.timers[0]!.callback();
    await vi.waitFor(() => expect(input.sockets).toHaveLength(2));
    expect(input.sockets[1]?.url).toContain("token=ws-token&cursor=41");
    input.sockets[1]!.emitClose();
    input.source.dispose();
    expect(input.timers.at(-1)?.cleared).toBe(true);
    expect(input.sockets[1]?.closed).toBe(true);
  });

  it("refreshes each unseen cursor once, including a lower cursor committed after a higher one", async () => {
    const input = harness();
    const ws = await start(input);
    ws.emit({ type: "chat.replay.end", nextCursor: 3 });
    for (const cursor of [5, 4, 5, 4]) ws.emit(event(cursor));
    expect(input.invalidations).toEqual([
      { type: "chat.changed", chatId: "chat_5", cursor: 5, revision: 5, eventType: "chat.updated" },
      { type: "chat.changed", chatId: "chat_4", cursor: 4, revision: 4, eventType: "chat.updated" },
    ]);
  });

  it("caps and evicts the seen-cursor dedupe registry instead of growing for the process lifetime", async () => {
    const input = harness({ maxSeenCursors: 2 });
    const ws = await start(input);
    ws.emit({ type: "chat.replay.end", nextCursor: 0 });
    for (const cursor of [1, 2, 3, 3, 1]) ws.emit(event(cursor, "chat_cursor"));
    expect(input.invalidations.map((next) => next.type === "chat.changed" ? next.cursor : 0))
      .toEqual([1, 2, 3, 1]);
  });

  it("turns a replay gap into one canonical full refresh and rejects unsafe frames", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = harness();
    const ws = await start(input);
    ws.emit({ type: "chat.replay.gap", reason: "cursor_unavailable" });
    ws.emit({ type: "chat.replay.end", nextCursor: 12 });
    ws.onmessage?.({ data: "x".repeat(16 * 1024 + 1) });
    ws.onmessage?.({ data: "{" });
    ws.emit({ ...event(13), event: { ...event(13).event, transcript: "private" } });
    expect(input.invalidations).toEqual([{ type: "chat.full_refresh", cursor: 12 }]);
    expect(warn).toHaveBeenCalledWith("[canonical-chat] event stream sent invalid JSON:", "SyntaxError");
  });

  it("bounds shared consumers and fails safely when credentials are unavailable", async () => {
    let attempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = harness({
      maxConsumers: 2,
      fetchWebSocketToken: vi.fn(async () => {
        if (++attempts === 1) throw new Error("credential secret");
        return "recovered-token";
      }),
    });
    const first = input.source.subscribe(() => undefined);
    input.source.subscribe(() => undefined);
    expect(() => input.source.subscribe(() => undefined)).toThrow(/consumer|subscriber|limit/i);
    await expect(input.source.start()).resolves.toBeUndefined();
    expect(input.sockets).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("credential secret");
    input.timers[0]!.callback();
    await vi.waitFor(() => expect(input.sockets[0]?.url).toContain("token=recovered-token"));
    expect(input.source.activeInvalidationConsumerCount()).toBe(2);
    first.dispose();
    expect(input.source.activeInvalidationConsumerCount()).toBe(1);
    input.source.dispose();
    expect(input.source.activeInvalidationConsumerCount()).toBe(0);
  });

  it("reports safe error categories for invalid origins and socket construction failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalid = harness({ gatewayOrigin: "file:///private/runtime" });
    await invalid.source.start();
    expect(warn).toHaveBeenCalledWith("[canonical-chat] event stream origin unavailable:", "Error");
    invalid.source.dispose();

    const failed = harness({ createWebSocket: () => { throw new RangeError("sensitive socket detail"); } });
    await failed.source.start();
    expect(warn).toHaveBeenCalledWith("[canonical-chat] event stream connection unavailable:", "RangeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive socket detail");
    failed.source.dispose();
  });
});
