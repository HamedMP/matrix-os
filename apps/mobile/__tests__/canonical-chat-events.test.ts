import { fetch as streamingFetch } from "expo/fetch";

import {
  createCanonicalChatEventSource,
  type CanonicalChatInvalidation,
} from "../lib/canonical-chat-events";

jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("@/lib/gateway-client", () => ({ assertSecureTokenTransport: jest.fn() }));
// The shared contracts barrel pulls in ESM-only micromark, which this Jest suite cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

const mockFetch = streamingFetch as unknown as jest.Mock;
const GATEWAY_URL = "https://example.test/vm/alice?runtime=primary";
const STREAM_URL = "https://example.test/vm/alice/api/chats/events?runtime=primary&fundingVersion=1";
const createdAt = "2026-09-06T00:00:00.000Z";

const chat = {
  id: "chat_content", ownerScope: { type: "personal", ownerId: "owner_test" },
  title: "Content", lifecycle: "active", attention: "none", revision: 2, messageCount: 0,
  createdAt, updatedAt: createdAt,
};
const event = { cursor: 7, revision: 2, chatId: chat.id, eventType: "run.message", createdAt };
const contentFrame = {
  type: "chat.content",
  event,
  content: {
    record: { chat },
    messageDelta: {
      message: {
        id: "msg_content", chatId: chat.id, role: "assistant", state: "pending", seq: 1,
        createdAt, parts: [{ type: "text", text: "hello" }],
      },
      partIndex: 0,
      offset: 0,
    },
  },
};

/** A response whose body the test feeds chunk by chunk, like a live SSE connection. */
function streamingResponse() {
  const chunks: { done: boolean; value?: Uint8Array }[] = [];
  let wake: (() => void) | undefined;
  const push = (chunk: { done: boolean; value?: Uint8Array }) => {
    chunks.push(chunk);
    wake?.();
  };
  return {
    response: {
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            while (chunks.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return chunks.shift()!;
          },
        }),
      },
    },
    emit: (raw: string) => push({ done: false, value: new TextEncoder().encode(raw) }),
    close: () => push({ done: true }),
  };
}

function sse(frame: unknown): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

function connectedSource() {
  const source = createCanonicalChatEventSource({ gatewayUrl: GATEWAY_URL, getToken: async () => "clerk-token" });
  const events: CanonicalChatInvalidation[] = [];
  source.subscribe((next) => events.push(next));
  source.connect();
  return { source, events };
}

const settle = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers();
  mockFetch.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("createCanonicalChatEventSource", () => {
  it("opens the content-carrying event stream with the bearer token", async () => {
    mockFetch.mockResolvedValue(streamingResponse().response);
    const { source } = connectedSource();
    await settle();

    expect(mockFetch).toHaveBeenCalledWith(STREAM_URL, expect.objectContaining({
      headers: {
        Accept: "text/event-stream",
        "X-Matrix-Chat-Protocol": "2",
        Authorization: "Bearer clerk-token",
      },
    }));
    source.disconnect();
  });

  it("delivers streamed content even when a frame is split across chunks", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    const raw = `: heartbeat\n\nid: 7\n${sse(contentFrame)}`;
    stream.emit(raw.slice(0, 40));
    await settle();
    expect(events).toEqual([]);

    stream.emit(raw.slice(40));
    await settle();
    expect(events).toEqual([{
      type: "chat.changed", chatId: chat.id, cursor: 7, eventType: "run.message", content: contentFrame,
    }]);
    source.disconnect();
  });

  it("reports content-less events as plain invalidations", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    stream.emit(
      sse({ type: "chat.stream.attached" })
        + sse({ type: "chat.replay.end" })
        + sse({ type: "chat.event", event: { ...event, eventType: "chat.deleted" } }),
    );
    await settle();

    expect(events).toEqual([{ type: "chat.changed", chatId: chat.id, cursor: 7, eventType: "chat.deleted" }]);
    source.disconnect();
  });

  it("collapses the events replayed on connect into one full refresh", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    stream.emit(
      sse({ type: "chat.stream.attached" })
        + [5, 6, 7].map((cursor) => sse({ type: "chat.event", event: { ...event, cursor } })).join("")
        + sse({ type: "chat.replay.end", nextCursor: 7 }),
    );
    await settle();

    expect(events).toEqual([{ type: "chat.full_refresh" }]);
    source.disconnect();
  });

  it("resumes after the newest replayed event", async () => {
    const first = streamingResponse();
    mockFetch.mockResolvedValueOnce(first.response).mockResolvedValueOnce(streamingResponse().response);
    const { source } = connectedSource();
    await settle();

    first.emit(sse({ type: "chat.stream.attached" }) + sse({ type: "chat.event", event: { ...event, cursor: 12 } }));
    first.close();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockFetch.mock.calls[1][1].headers["Last-Event-ID"]).toBe("12");
    source.disconnect();
  });

  it("resumes from the last cursor and asks for a full refresh once replay ends", async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    mockFetch.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const { source, events } = connectedSource();
    await settle();

    first.emit(sse({ type: "chat.stream.attached" }) + sse(contentFrame));
    first.close();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1].headers["Last-Event-ID"]).toBe("7");

    second.emit(sse({ type: "chat.replay.end", nextCursor: 9 }));
    await settle();
    expect(events.at(-1)).toEqual({ type: "chat.full_refresh" });
    source.disconnect();
  });

  it("asks for a full refresh when a first connection is told events were skipped", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    stream.emit(
      sse({ type: "chat.stream.attached" })
        + sse({ type: "chat.replay.gap", reason: "cursor_unavailable" })
        + sse({ type: "chat.replay.end", nextCursor: 512 }),
    );
    await settle();

    expect(events).toEqual([{ type: "chat.full_refresh" }]);
    source.disconnect();
  });

  it("does not refresh after a first connection that skipped nothing", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    stream.emit(sse({ type: "chat.stream.attached" }) + sse({ type: "chat.replay.end" }));
    await settle();

    expect(events).toEqual([]);
    source.disconnect();
  });

  it("reconnects when the stream goes silent", async () => {
    mockFetch.mockResolvedValue(streamingResponse().response);
    const { source } = connectedSource();
    await settle();

    await jest.advanceTimersByTimeAsync(47_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    source.disconnect();
  });

  it("backs off when the stream keeps dropping right after it attaches", async () => {
    mockFetch.mockImplementation(async () => {
      const stream = streamingResponse();
      stream.emit(sse({ type: "chat.stream.attached" }) + sse({ type: "chat.replay.end" }));
      stream.close();
      return stream.response;
    });
    const { source } = connectedSource();
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Attaching is not proof the connection works: the wait keeps doubling.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(3_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    source.disconnect();
  });

  it("reconnects promptly again once a connection has held", async () => {
    const streams = [streamingResponse(), streamingResponse(), streamingResponse()];
    for (const stream of streams) mockFetch.mockResolvedValueOnce(stream.response);
    const { source } = connectedSource();
    await settle();

    streams[0]!.close();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    streams[1]!.emit(sse({ type: "chat.stream.attached" }) + sse({ type: "chat.replay.end" }));
    await jest.advanceTimersByTimeAsync(20_000);
    streams[1]!.close();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    source.disconnect();
  });

  it("reports when the stream is caught up and when it is lost", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source } = connectedSource();
    const live: boolean[] = [];
    source.subscribeLive((next) => live.push(next));
    await settle();

    stream.emit(sse({ type: "chat.stream.attached" }));
    await settle();
    expect(live).toEqual([]);

    stream.emit(sse({ type: "chat.replay.end" }));
    await settle();
    expect(live).toEqual([true]);

    stream.close();
    await settle();
    expect(live).toEqual([true, false]);
    source.disconnect();
  });

  it("stays closed after disconnect", async () => {
    const stream = streamingResponse();
    mockFetch.mockResolvedValue(stream.response);
    const { source, events } = connectedSource();
    await settle();

    source.disconnect();
    stream.emit(sse(contentFrame));
    stream.close();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(events).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
