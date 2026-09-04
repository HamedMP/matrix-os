import { describe, expect, it, vi } from "vitest";
import {
  ChatEventFrameTooLarge,
  createCanonicalChatEventSource,
  createCanonicalChatSseParser,
  type CanonicalChatInvalidation,
} from "../../packages/ui/src/canonical-chat-event-source.js";

const encoder = new TextEncoder();

function streamingResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(next) { controller = next; },
    cancel,
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    emit(raw: string) { controller.enqueue(encoder.encode(raw)); },
    close() { controller.close(); },
    cancel,
  };
}

function event(cursor: number, chatId = `chat_${cursor}`) {
  return {
    type: "chat.event",
    event: {
      cursor,
      chatId,
      revision: cursor,
      eventType: "run.message",
      createdAt: "2026-09-04T00:00:00.000Z",
    },
  };
}

describe("shared canonical Chat SSE parser", () => {
  it("parses fragmented UTF-8 records, comments, ids, and multiple data lines", () => {
    const records: Array<{ data: string; id?: string }> = [];
    const activity = vi.fn();
    const parser = createCanonicalChatSseParser({
      onData: (data, id) => records.push({ data, ...(id === undefined ? {} : { id }) }),
      onActivity: activity,
    });
    const split = encoder.encode("id: 8\r\ndata: 你好\r\ndata: world\r\n\r\n: heartbeat\n\n");
    parser.push(split.slice(0, 17));
    parser.push(split.slice(17));

    expect(records).toEqual([{ id: "8", data: "你好\nworld" }]);
    expect(activity).toHaveBeenCalled();
  });

  it("rejects an incomplete event before parser state exceeds 16 KiB", () => {
    const parser = createCanonicalChatSseParser({ onData: () => undefined, onActivity: () => undefined });
    expect(() => parser.push(encoder.encode(`data: ${"x".repeat(16 * 1024)}`)))
      .toThrow(ChatEventFrameTooLarge);
  });

  it("applies the event limit to UTF-8 bytes rather than JavaScript characters", () => {
    const parser = createCanonicalChatSseParser({ onData: () => undefined, onActivity: () => undefined });
    expect(() => parser.push(encoder.encode(`data: ${"🙂".repeat(5_000)}`)))
      .toThrow(ChatEventFrameTooLarge);
  });

  it("does not dispatch a truncated final record", () => {
    const onData = vi.fn();
    const parser = createCanonicalChatSseParser({ onData, onActivity: () => undefined });
    parser.push(encoder.encode("data: partial"));
    parser.finish();
    expect(onData).not.toHaveBeenCalled();
  });
});

describe("shared canonical Chat event source", () => {
  it("opens only after server attachment and publishes safe replay metadata", async () => {
    const stream = streamingResponse();
    const openStream = vi.fn(async () => stream.response);
    const source = createCanonicalChatEventSource({ openStream });
    const invalidations: CanonicalChatInvalidation[] = [];
    source.subscribe((next) => invalidations.push(next));

    await source.start();
    expect(source.connectionState()).toBe("connecting");
    stream.emit('data: {"type":"chat.stream.attached"}\n\n');
    stream.emit(`id: 9\ndata: ${JSON.stringify(event(9, "chat_streamed"))}\n\n`);
    stream.emit('data: {"type":"chat.replay.end","nextCursor":9}\n\n');

    await vi.waitFor(() => expect(source.connectionState()).toBe("open"));
    await vi.waitFor(() => expect(invalidations).toEqual([
      { type: "chat.changed", chatId: "chat_streamed", cursor: 9, revision: 9, eventType: "run.message" },
      { type: "chat.full_refresh", cursor: 9 },
    ]));
    source.dispose();
  });

  it("reconnects with the last cursor after EOF and bounds consumer growth", async () => {
    const streams = [streamingResponse(), streamingResponse()];
    const opens: Array<{ cursor?: number; signal: AbortSignal }> = [];
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    const source = createCanonicalChatEventSource({
      maxConsumers: 1,
      openStream: async (input) => {
        opens.push(input);
        return streams[opens.length - 1]!.response;
      },
      setTimeoutFn(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn(timer) { (timer as typeof timers[number]).cleared = true; },
    });
    const subscription = source.subscribe(() => undefined);
    expect(() => source.subscribe(() => undefined)).toThrow("Chat event consumer limit reached");

    await source.start();
    streams[0]!.emit(`id: 5\ndata: ${JSON.stringify(event(5))}\n\n`);
    streams[0]!.emit(`id: 4\ndata: ${JSON.stringify(event(4))}\n\n`);
    streams[0]!.emit('data: {"type":"chat.replay.end"}\n\n');
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    streams[0]!.close();
    await vi.waitFor(() => expect(source.connectionState()).toBe("reconnecting"));
    const reconnect = timers.find((timer) => timer.delay === 250)!;
    reconnect.callback();
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    expect(opens[1]?.cursor).toBe(5);

    subscription.dispose();
    source.dispose();
    expect(opens[1]?.signal.aborted).toBe(true);
  });

  it("aborts and falls back when the HTTP response is not an event stream", async () => {
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const source = createCanonicalChatEventSource({
      openStream: async () => Response.json({ error: "not available" }, { status: 404 }),
      setTimeoutFn(callback, delay) {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: () => undefined,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await source.start();

    expect(source.connectionState()).toBe("reconnecting");
    expect(timers.some((timer) => timer.delay === 250)).toBe(true);
    source.dispose();
  });

  it("rotates or evicts an inactive stream through bounded abort signals", async () => {
    const stream = streamingResponse();
    const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];
    let signal: AbortSignal | undefined;
    const source = createCanonicalChatEventSource({
      openStream: async (input) => {
        signal = input.signal;
        return stream.response;
      },
      setTimeoutFn(callback, delay) {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn(timer) { (timer as typeof timers[number]).cleared = true; },
    });
    await source.start();
    expect(timers.some((timer) => timer.delay === 45_000)).toBe(true);
    expect(timers.some((timer) => timer.delay === 5 * 60 * 1000)).toBe(true);

    timers.find((timer) => timer.delay === 45_000)!.callback();

    expect(signal?.aborted).toBe(true);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(source.connectionState()).toBe("reconnecting");
    expect(timers.some((timer) => timer.delay === 250)).toBe(true);
    source.dispose();
  });
});
