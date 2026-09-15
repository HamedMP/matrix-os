import type { AppStateStatus } from "react-native";
import type { CanonicalChatContentFrame } from "@matrix-os/contracts/canonical-chat-streaming";
import {
  createCanonicalChatEventSource,
  reconnectCanonicalChatOnForeground,
} from "@/lib/canonical-chat-events";

jest.mock("@/lib/gateway-client", () => ({ assertSecureTokenTransport: jest.fn() }));

const encoder = new TextEncoder();

async function waitFor(assertion: () => void): Promise<void> {
  let latest: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      latest = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw latest;
}

function streamingResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(next) { controller = next; },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    emit(frame: unknown) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
  };
}

function contentFrame(cursor: number, revision = cursor): CanonicalChatContentFrame {
  const createdAt = "2026-09-10T00:00:00.000Z";
  return {
    type: "chat.content",
    event: { cursor, revision, chatId: "chat_mobile", eventType: "run.message", createdAt },
    content: {
      record: { chat: {
        id: "chat_mobile",
        ownerScope: { type: "personal", ownerId: "owner_mobile" },
        title: "Mobile",
        lifecycle: "active",
        attention: "none",
        revision,
        messageCount: 1,
        createdAt,
        updatedAt: createdAt,
      } },
      messageDelta: {
        message: {
          id: "msg_mobile",
          chatId: "chat_mobile",
          seq: 1,
          role: "assistant",
          state: "pending",
          parts: [{ type: "text", text: "hello" }],
          createdAt,
        },
        partIndex: 0,
        offset: 0,
      },
    },
  };
}

describe("Native Mobile canonical Chat event source", () => {
  it("uses the versioned HTTP content stream and obtains fresh auth on foreground reconnect", async () => {
    const streams = [streamingResponse(), streamingResponse()];
    let openCount = 0;
    const fetchFn = jest.fn(async () => streams[openCount++]!.response);
    const getToken = jest.fn()
      .mockResolvedValueOnce("token-one")
      .mockResolvedValueOnce("token-two");
    const received: unknown[] = [];
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events?runtime=primary",
      getToken,
      fetchFn,
    });
    source.subscribe((event) => received.push(event));
    try {
      await source.start();
      streams[0]!.emit({ type: "chat.stream.attached" });
      streams[0]!.emit({ type: "chat.replay.end" });
      streams[0]!.emit(contentFrame(1));
      await waitFor(() => expect(received).toHaveLength(1));

      expect(fetchFn).toHaveBeenNthCalledWith(1,
      "https://app.matrix-os.test/api/chats/events?runtime=primary&messageVersion=2",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/event-stream",
          Authorization: "Bearer token-one",
          "X-Matrix-Chat-Protocol": "2",
        }),
        signal: expect.any(Object),
      }),
    );
      expect(received).toEqual([expect.objectContaining({
        type: "chat.changed",
        chatId: "chat_mobile",
        content: contentFrame(1),
      })]);

      await source.reconnect();
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(fetchFn).toHaveBeenNthCalledWith(2,
      "https://app.matrix-os.test/api/chats/events?runtime=primary&messageVersion=2",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-two",
          "Last-Event-ID": "1",
        }),
      }),
      );
    } finally {
      source.dispose();
    }
  });

  it("turns replay gaps into one authoritative refresh and deduplicates cursors", async () => {
    const stream = streamingResponse();
    const received: unknown[] = [];
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events",
      getToken: async () => "token",
      fetchFn: async () => stream.response,
    });
    source.subscribe((event) => received.push(event));
    try {
      await source.start();
      stream.emit({ type: "chat.stream.attached" });
      stream.emit({ type: "chat.replay.gap", reason: "cursor_unavailable" });
      stream.emit(contentFrame(4));
      stream.emit(contentFrame(4));
      stream.emit({ type: "chat.replay.end", nextCursor: 4 });
      await waitFor(() => expect(received).toHaveLength(2));

      expect(received).toEqual([
        expect.objectContaining({ type: "chat.changed", cursor: 4 }),
        { type: "chat.full_refresh", cursor: 4 },
      ]);
    } finally {
      source.dispose();
    }
  });

  it("drops a lower out-of-order cursor after a newer event was applied", async () => {
    const stream = streamingResponse();
    const received: unknown[] = [];
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events",
      getToken: async () => "token",
      fetchFn: async () => stream.response,
    });
    source.subscribe((event) => received.push(event));
    try {
      await source.start();
      stream.emit({ type: "chat.stream.attached" });
      stream.emit({ type: "chat.replay.end" });
      stream.emit(contentFrame(5));
      stream.emit(contentFrame(4));
      await waitFor(() => expect(received).toHaveLength(1));

      expect(received).toEqual([expect.objectContaining({
        type: "chat.changed",
        cursor: 5,
      })]);
    } finally {
      source.dispose();
    }
  });

  it("applies a complete content replay without forcing a redundant snapshot", async () => {
    const streams = [streamingResponse(), streamingResponse()];
    let openCount = 0;
    const received: unknown[] = [];
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events",
      getToken: async () => "token",
      fetchFn: async () => streams[openCount++]!.response,
    });
    source.subscribe((event) => received.push(event));
    try {
      await source.start();
      streams[0]!.emit({ type: "chat.stream.attached" });
      streams[0]!.emit({ type: "chat.replay.end", nextCursor: 1 });
      await source.reconnect();
      streams[1]!.emit({ type: "chat.stream.attached" });
      streams[1]!.emit(contentFrame(2));
      streams[1]!.emit({ type: "chat.replay.end", nextCursor: 2 });
      await waitFor(() => expect(received).toHaveLength(1));

      expect(received).toEqual([expect.objectContaining({
        type: "chat.changed",
        cursor: 2,
      })]);
    } finally {
      source.dispose();
    }
  });

  it("fences an obsolete authentication generation before it can open a stream", async () => {
    let releaseFirst!: (token: string) => void;
    const firstToken = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const fetchFn = jest.fn(async () => streamingResponse().response);
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events",
      getToken: jest.fn()
        .mockImplementationOnce(() => firstToken)
        .mockResolvedValueOnce("fresh-token"),
      fetchFn,
    });

    const staleStart = source.start();
    await source.reconnect();
    releaseFirst("stale-token");
    await staleStart;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
    }));
    source.dispose();
  });

  it("bounds a stalled stream handshake and reconnects with fresh auth", async () => {
    const timers: (() => void)[] = [];
    const stream = streamingResponse();
    const getToken = jest.fn()
      .mockResolvedValueOnce("stalled-token")
      .mockResolvedValueOnce("fresh-token");
    const fetchFn = jest.fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(stream.response);
    const source = createCanonicalChatEventSource({
      url: "https://app.matrix-os.test/api/chats/events",
      getToken,
      fetchFn,
      setTimeoutFn(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimeoutFn: jest.fn(),
    });

    void source.start();
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    timers.shift()?.();
    timers.shift()?.();
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fresh-token" }),
      signal: expect.any(Object),
    }));
    source.dispose();
  });

  it("releases the stream in background and reconnects once on foreground", () => {
    let onChange!: (state: AppStateStatus) => void;
    const remove = jest.fn();
    const source = {
      suspend: jest.fn(),
      reconnect: jest.fn(async () => undefined),
    };
    const subscription = reconnectCanonicalChatOnForeground(source, {
      currentState: "active",
      addEventListener(_type, listener) {
        onChange = listener;
        return { remove };
      },
    });

    onChange("background");
    onChange("active");
    onChange("active");

    expect(source.suspend).toHaveBeenCalledTimes(1);
    expect(source.reconnect).toHaveBeenCalledTimes(1);
    subscription.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
