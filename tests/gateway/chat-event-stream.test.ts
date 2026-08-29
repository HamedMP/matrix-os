import { describe, expect, it, vi } from "vitest";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import type { ChatOutboxEvent, ChatOwner } from "../../packages/gateway/src/chat/records.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import * as canonicalChatRoutes from "../../packages/gateway/src/chat/routes.js";

type ReplayWindow = {
  events: ChatOutboxEvent[];
  gap: boolean;
  nextCursor?: number;
};

type ChatEventRepository = {
  registerOutboxSink(sink: (input: { owner: ChatOwner; event: ChatOutboxEvent }) => void): {
    dispose(): void;
  };
  replayOutboxWindow(owner: ChatOwner, input: {
    afterCursor?: number;
    limit: number;
  }): Promise<ReplayWindow>;
};

type ChatEventStreamSocket = {
  send(data: string): void;
  close(): void;
};

type ChatEventStream = {
  open(input: {
    ws: ChatEventStreamSocket;
    principal: RequestPrincipal;
    cursor?: number;
  }): Promise<{ onMessage(raw: string): void; onClose(): void }>;
  evictStaleSubscribers(): void;
  activeSubscriberCount(): number;
  shutdown(): void;
};

type CreateCanonicalChatEventStream = (options: {
  repository: ChatEventRepository;
  maxSubscribers?: number;
  maxSubscribersPerOwner?: number;
  subscriberTtlMs?: number;
  maxAttachBuffer?: number;
  now?: () => number;
}) => ChatEventStream;

type RegisterCanonicalChatEventRoute = (options: {
  mount(
    path: string,
    open: (input: {
      context: unknown;
      ws: ChatEventStreamSocket;
      cursor?: string;
    }) => Promise<void>,
  ): void;
  getPrincipal(context: unknown): RequestPrincipal;
  stream: Pick<ChatEventStream, "open">;
}) => void;

type CloseCanonicalChatEventLifecycle = (options: {
  stream: Pick<ChatEventStream, "shutdown">;
  releaseRepository(): Promise<void>;
}) => Promise<void>;

const createCanonicalChatEventStream = (
  canonicalChatRoutes as unknown as {
    createCanonicalChatEventStream?: CreateCanonicalChatEventStream;
  }
).createCanonicalChatEventStream;
const registerCanonicalChatEventRoute = (
  canonicalChatRoutes as unknown as {
    registerCanonicalChatEventRoute?: RegisterCanonicalChatEventRoute;
  }
).registerCanonicalChatEventRoute;
const closeCanonicalChatEventLifecycle = (
  canonicalChatRoutes as unknown as {
    closeCanonicalChatEventLifecycle?: CloseCanonicalChatEventLifecycle;
  }
).closeCanonicalChatEventLifecycle;

const principalA: RequestPrincipal = { userId: "owner_a", source: "jwt" };
const principalB: RequestPrincipal = { userId: "owner_b", source: "jwt" };

function outbox(
  cursor: number,
  chatId = "chat_event_a",
  overrides: Partial<ChatOutboxEvent> = {},
): ChatOutboxEvent {
  return {
    cursor,
    chatId,
    revision: cursor,
    eventType: "chat.updated",
    payload: {},
    createdAt: `2026-08-29T00:00:${String(cursor).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function socket(options: { failSend?: boolean; onClose?: () => void } = {}) {
  return {
    sent: [] as unknown[],
    closed: false,
    failSend: options.failSend ?? false,
    send(data: string) {
      if (this.failSend) throw new Error("send failed");
      this.sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
      options.onClose?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function repositoryHarness(
  replay: ChatEventRepository["replayOutboxWindow"] = async () => ({
    events: [],
    gap: false,
  }),
) {
  let sink: ((input: { owner: ChatOwner; event: ChatOutboxEvent }) => void) | undefined;
  let disposed = false;
  const repository: ChatEventRepository = {
    replayOutboxWindow: vi.fn(replay),
    registerOutboxSink(next) {
      if (sink) throw new Error("outbox sink already registered");
      sink = next;
      return {
        dispose() {
          disposed = true;
          sink = undefined;
        },
      };
    },
  };
  return {
    repository,
    publish(ownerId: string, event: ChatOutboxEvent) {
      sink?.({ owner: { type: "personal", ownerId }, event });
    },
    disposed: () => disposed,
  };
}

function createStream(options: Parameters<CreateCanonicalChatEventStream>[0]): ChatEventStream {
  expect(
    createCanonicalChatEventStream,
    "canonical Chat must expose one shared owner-level event stream",
  ).toBeTypeOf("function");
  return createCanonicalChatEventStream!(options);
}

describe("canonical Chat event stream", () => {
  it("subscribes before replay, buffers live commits, dedupes the overlap, and publishes safe metadata only", async () => {
    const replay = deferred<ReplayWindow>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createStream({ repository: harness.repository });
    const ws = socket();

    const opening = stream.open({ ws, principal: principalA, cursor: 0 });
    harness.publish("owner_a", outbox(2, "chat_event_a", {
      payload: {
        transcript: "private transcript",
        provider: "provider-secret",
        path: "/home/private/project",
      },
    }));
    harness.publish("owner_a", outbox(3, "chat_event_b"));
    replay.resolve({
      events: [outbox(1), outbox(2)],
      gap: false,
      nextCursor: 2,
    });
    await opening;

    expect(ws.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "chat.stream.attached",
      "chat.event",
      "chat.event",
      "chat.replay.end",
      "chat.event",
    ]);
    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "chat.event")
      .map((frame) => (frame as { event: { cursor: number } }).event.cursor)).toEqual([1, 2, 3]);
    expect(JSON.stringify(ws.sent)).not.toMatch(/private transcript|provider-secret|home\/private|payload/);
  });

  it("does not skip an unseen lower cursor that commits after a higher cursor", async () => {
    const harness = repositoryHarness();
    const stream = createStream({ repository: harness.repository });
    const ws = socket();
    await stream.open({ ws, principal: principalA, cursor: 3 });

    harness.publish("owner_a", outbox(5));
    harness.publish("owner_a", outbox(4));
    harness.publish("owner_a", outbox(5));

    expect(ws.sent.filter((frame) => (frame as { type: string }).type === "chat.event")
      .map((frame) => (frame as { event: { cursor: number } }).event.cursor)).toEqual([5, 4]);
  });

  it("isolates owners and emits an explicit full-refresh signal for a missing or pruned cursor", async () => {
    const harness = repositoryHarness(async (owner) => owner.ownerId === "owner_a"
      ? { events: [], gap: true }
      : { events: [outbox(8, "chat_owner_b")], gap: false, nextCursor: 8 });
    const stream = createStream({ repository: harness.repository });
    const a = socket();
    const b = socket();

    await stream.open({ ws: a, principal: principalA, cursor: 2 });
    await stream.open({ ws: b, principal: principalB, cursor: 7 });
    harness.publish("owner_b", outbox(9, "chat_owner_b"));

    expect(a.sent).toContainEqual({
      type: "chat.replay.gap",
      reason: "cursor_unavailable",
    });
    expect(a.sent).not.toContainEqual(expect.objectContaining({ type: "chat.event" }));
    expect(b.sent.filter((frame) => (frame as { type: string }).type === "chat.event"))
      .toHaveLength(2);
  });

  it("bounds attach buffering and inbound frames, and validates ping and detach", async () => {
    const replay = deferred<ReplayWindow>();
    const harness = repositoryHarness(() => replay.promise);
    const stream = createStream({ repository: harness.repository, maxAttachBuffer: 2 });
    const overflow = socket();
    const opening = stream.open({ ws: overflow, principal: principalA });
    harness.publish("owner_a", outbox(1));
    harness.publish("owner_a", outbox(2));
    harness.publish("owner_a", outbox(3));
    replay.resolve({ events: [], gap: false });
    await opening;
    expect(overflow.closed).toBe(true);

    const validHarness = repositoryHarness();
    const validStream = createStream({ repository: validHarness.repository });
    const ws = socket();
    const session = await validStream.open({ ws, principal: principalA });
    session.onMessage("x".repeat(4097));
    expect(ws.sent).toContainEqual(expect.objectContaining({
      type: "chat.stream.error",
      error: expect.objectContaining({ code: "invalid_frame" }),
    }));

    const pingSocket = socket();
    const ping = await validStream.open({ ws: pingSocket, principal: principalB });
    ping.onMessage(JSON.stringify({ type: "ping", unexpected: true }));
    ping.onMessage(JSON.stringify({ type: "ping" }));
    expect(pingSocket.sent).toContainEqual({ type: "pong" });
    ping.onMessage(JSON.stringify({ type: "detach" }));
    expect(pingSocket.closed).toBe(true);
  });

  it("reports unexpected JSON parser failures without exposing the raw error", async () => {
    const harness = repositoryHarness();
    const stream = createStream({ repository: harness.repository });
    const ws = socket();
    const session = await stream.open({ ws, principal: principalA });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw new TypeError("sensitive parser detail");
    });

    try {
      expect(() => session.onMessage('{"type":"ping"}')).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        "[chat/event-stream] JSON parse failed:",
        "TypeError",
      );
      expect(JSON.stringify(ws.sent)).not.toContain("sensitive parser detail");
      expect(ws.sent).toContainEqual(expect.objectContaining({
        type: "chat.stream.error",
        error: expect.objectContaining({ code: "invalid_frame" }),
      }));
    } finally {
      parse.mockRestore();
      warn.mockRestore();
    }
  });

  it("enforces global and per-owner caps, TTL eviction, failed-sender removal, and close cleanup", async () => {
    let now = 0;
    const harness = repositoryHarness();
    const stream = createStream({
      repository: harness.repository,
      maxSubscribers: 2,
      maxSubscribersPerOwner: 1,
      subscriberTtlMs: 10,
      now: () => now,
    });
    const firstA = socket();
    const secondA = socket();
    const ownerB = socket();

    await stream.open({ ws: firstA, principal: principalA });
    now = 1;
    await stream.open({ ws: secondA, principal: principalA });
    expect(firstA.closed).toBe(true);
    await stream.open({ ws: ownerB, principal: principalB });
    expect(stream.activeSubscriberCount()).toBe(2);

    secondA.failSend = true;
    harness.publish("owner_a", outbox(10));
    expect(stream.activeSubscriberCount()).toBe(1);
    expect(ownerB.closed).toBe(false);

    now = 20;
    stream.evictStaleSubscribers();
    expect(ownerB.closed).toBe(true);
    expect(stream.activeSubscriberCount()).toBe(0);

    const detached = socket();
    const session = await stream.open({ ws: detached, principal: principalA });
    session.onClose();
    expect(stream.activeSubscriberCount()).toBe(0);
  });

  it("closes and drains every subscriber and the repository sink on shutdown", async () => {
    const order: string[] = [];
    const harness = repositoryHarness();
    const originalRegister = harness.repository.registerOutboxSink;
    harness.repository.registerOutboxSink = (sink) => {
      const registration = originalRegister(sink);
      return { dispose: () => { order.push("sink.dispose"); registration.dispose(); } };
    };
    const stream = createStream({ repository: harness.repository });
    const ws = socket({ onClose: () => order.push("socket.close") });
    await stream.open({ ws, principal: principalA });

    stream.shutdown();

    expect(ws.sent.at(-1)).toEqual({
      type: "chat.stream.closing",
      reason: "server_shutdown",
    });
    expect(stream.activeSubscriberCount()).toBe(0);
    expect(harness.disposed()).toBe(true);
    expect(order).toEqual(["socket.close", "sink.dispose"]);
  });

  it("drains the Chat stream before releasing the shared repository through the public close seam", async () => {
    expect(closeCanonicalChatEventLifecycle).toBeTypeOf("function");
    const order: string[] = [];

    await closeCanonicalChatEventLifecycle!({
      stream: { shutdown: () => { order.push("stream.shutdown"); } },
      releaseRepository: async () => { order.push("repository.release"); },
    });

    expect(order).toEqual(["stream.shutdown", "repository.release"]);
  });

  it("allows query-token auth only for the exact Chat WebSocket path", async () => {
    const middleware = authMiddleware("secret-token");
    const calls: string[] = [];
    const makeContext = (path: string, token?: string) => ({
      req: {
        path,
        url: `http://localhost${path}${token ? `?token=${token}` : ""}`,
        header: () => undefined,
      },
      json: (body: unknown, status: number) => ({ body, status }),
      set: () => undefined,
    });

    await middleware(makeContext("/ws/chats/events", "secret-token") as never, async () => {
      calls.push("ws");
    });
    const rest = await middleware(makeContext("/api/chats", "secret-token") as never, async () => {
      calls.push("rest");
    });

    expect(calls).toEqual(["ws"]);
    expect(rest).toEqual({ body: { error: "Unauthorized" }, status: 401 });
  });

  it("registers the exact owner route and passes only the verified principal into the stream", async () => {
    expect(registerCanonicalChatEventRoute).toBeTypeOf("function");
    const context = { requestId: "request_verified_principal" };
    const ws = socket();
    const open = vi.fn(async () => ({ onMessage: () => undefined, onClose: () => undefined }));
    const getPrincipal = vi.fn(() => principalA);
    let routePath: string | undefined;
    let routeOpen: ((input: {
      context: unknown;
      ws: ChatEventStreamSocket;
      cursor?: string;
    }) => Promise<void>) | undefined;

    registerCanonicalChatEventRoute!({
      mount(path, handler) {
        routePath = path;
        routeOpen = handler;
      },
      getPrincipal,
      stream: { open },
    });
    await routeOpen?.({ context, ws, cursor: "12" });

    expect(routePath).toBe("/ws/chats/events");
    expect(getPrincipal).toHaveBeenCalledWith(context);
    expect(open).toHaveBeenCalledWith({ ws, principal: principalA, cursor: 12 });
  });
});
