import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodingAgentThreadEventStreamer,
  type DesktopCodingAgentThreadWebSocket,
} from "../../desktop/src/main/coding-agents/thread-event-stream";
import type { AuthService } from "../../desktop/src/main/auth/auth-service";

function auth(): AuthService {
  return {
    getToken: () => "desktop-token",
    getGatewayOrigin: () => "https://runtime.test",
  } as unknown as AuthService;
}

class FakeThreadWebSocket implements DesktopCodingAgentThreadWebSocket {
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

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function approvalResolvedEvent(threadId = "thread_desktop_1") {
  return {
    type: "approval.resolved",
    eventId: `evt_${threadId}_resolved`,
    threadId,
    occurredAt: "2026-07-06T00:05:00.000Z",
    approvalId: "appr_desktop_1",
    decision: "approve",
  };
}

describe("desktop coding-agent thread event streamer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects with a gateway-owned ws token and emits validated thread events", async () => {
    const emitted: unknown[] = [];
    const sockets: FakeThreadWebSocket[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "ws-token" }), { status: 200 }));
    const streamer = createCodingAgentThreadEventStreamer({
      auth: auth(),
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchFn,
      createWebSocket: (url) => {
        const socket = new FakeThreadWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await streamer.subscribe({ threadId: "thread_desktop_1", cursor: "evt_approval_1" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://runtime.test/api/auth/ws-token",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer desktop-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(sockets[0]?.url).toBe(
      "wss://runtime.test/ws/coding-agents/thread/thread_desktop_1?token=ws-token&cursor=evt_approval_1",
    );

    sockets[0]?.emitMessage(JSON.stringify({
      type: "thread.event",
      event: approvalResolvedEvent(),
    }));
    sockets[0]?.emitMessage(JSON.stringify({
      type: "thread.event",
      event: { ...approvalResolvedEvent(), accessToken: "secret" },
    }));

    expect(emitted).toEqual([{
      channel: "runtime:thread-event",
      payload: {
        threadId: "thread_desktop_1",
        event: approvalResolvedEvent(),
      },
    }]);
    expect(JSON.stringify(emitted)).not.toMatch(/desktop-token|ws-token|secret/);
    expect(warn).toHaveBeenCalledWith("[desktop] coding-agent thread stream sent invalid frame");
  });

  it("caps active subscriptions and evicts the oldest stream", async () => {
    const sockets: FakeThreadWebSocket[] = [];
    const streamer = createCodingAgentThreadEventStreamer({
      auth: auth(),
      emit: () => undefined,
      fetchFn: vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ token: "ws-token" }), { status: 200 }))),
      createWebSocket: (url) => {
        const socket = new FakeThreadWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      maxSubscriptions: 2,
    });

    await streamer.subscribe({ threadId: "thread_desktop_1" });
    await streamer.subscribe({ threadId: "thread_desktop_2" });
    await streamer.subscribe({ threadId: "thread_desktop_3" });

    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.closed).toBe(false);
    expect(sockets[2]?.closed).toBe(false);
  });

  it("drops stale overlapping subscribe attempts for the same thread", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchFn = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const sockets: FakeThreadWebSocket[] = [];
    const streamer = createCodingAgentThreadEventStreamer({
      auth: auth(),
      emit: () => undefined,
      fetchFn,
      createWebSocket: (url) => {
        const socket = new FakeThreadWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const slow = streamer.subscribe({ threadId: "thread_desktop_1", cursor: "evt_old" });
    const fast = streamer.subscribe({ threadId: "thread_desktop_1", cursor: "evt_new" });
    second.resolve(new Response(JSON.stringify({ token: "new-token" }), { status: 200 }));
    await fast;
    first.resolve(new Response(JSON.stringify({ token: "old-token" }), { status: 200 }));
    await slow;

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe(
      "wss://runtime.test/ws/coding-agents/thread/thread_desktop_1?token=new-token&cursor=evt_new",
    );
  });

  it("emits safe stream errors so the renderer can rehydrate snapshots", async () => {
    const emitted: unknown[] = [];
    const sockets: FakeThreadWebSocket[] = [];
    const streamer = createCodingAgentThreadEventStreamer({
      auth: auth(),
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "ws-token" }), { status: 200 })),
      createWebSocket: (url) => {
        const socket = new FakeThreadWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    await streamer.subscribe({ threadId: "thread_desktop_1", cursor: "evt_stale" });
    sockets[0]?.emitMessage(JSON.stringify({
      type: "thread.stream.error",
      error: {
        code: "stream_unavailable",
        safeMessage: "Thread stream unavailable",
        retryable: true,
      },
    }));

    expect(emitted).toEqual([{
      channel: "runtime:thread-stream-error",
      payload: {
        threadId: "thread_desktop_1",
        error: {
          code: "stream_unavailable",
          safeMessage: "Thread stream unavailable",
          retryable: true,
        },
      },
    }]);
  });
});
